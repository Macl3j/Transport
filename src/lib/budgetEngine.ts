// ============================================================
// budgetEngine.ts — HBM TruckCalc
// Monthly budget calculation per vehicle (tractor + trailer)
// Budget = Fixed costs (leasing + insurance from Supabase)
//        + Variable costs (km_target × per-km rates)
//        + Driver (km_target / driverKmPerDay × dailyCost)
// ============================================================

import { FLEET } from "@/lib/calculator";
import { type ExpenseMap, getMonthTotal } from "@/lib/expenseParser";

// ── Vehicle record (from Supabase vehicles table) ────────────
export interface VehicleRecord {
  registration:      string;
  vehicle_type:      "tractor" | "trailer" | "van";
  leasing_eur_mo?:   number;
  insurance_eur_mo?: number;
  service_cost_km?:  number;
  service_contract?: boolean;
  year_produced?:    number;
  avg_km_month?:     number;
}

// ── Budget settings (from AppSettings / Supabase) ─────────────
export interface BudgetSettings {
  kmTargetMo:      number;   // 10 000 km/month minimum per tractor
  tollEurPerKm:    number;   // 0.30 EUR/km average
  budgetMarginPct: number;   // 10% target margin
  fuelPriceEurL:   number;   // current fuel price EUR/l
  avgFuelL100:     number;   // fleet fuel consumption l/100km
  adblueRatePct:   number;   // AdBlue % of diesel volume (e.g. 3.5)
  driverDailyCost: number;   // EUR/day net (e.g. 181.95)
}

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
  kmTargetMo:      10_000,
  tollEurPerKm:    0.30,
  budgetMarginPct: 10,
  fuelPriceEurL:   1.25,
  avgFuelL100:     27.80,
  adblueRatePct:   3.5,
  driverDailyCost: 181.95,
};

// ── Monthly budget for one vehicle ────────────────────────────
export interface VehicleBudget {
  registration:     string;
  vehicleType:      "tractor" | "trailer" | "van";
  yearMonth:        string;     // "YYYY-MM" — the budget period

  // Fixed costs (monthly, from Supabase)
  leasingEurMo:     number;
  insuranceEurMo:   number;
  fixedTotal:       number;

  // Variable costs (for tractors — based on km target)
  kmTarget:         number;     // km planned for the month
  fuelEur:          number;     // fuel cost at target km
  adblueEur:        number;
  tollEur:          number;
  serviceEur:       number;
  driverEur:        number;     // driver cost at target km
  variableTotal:    number;

  // Budget totals
  totalCost:        number;
  minRevenue:       number;     // totalCost / (1 - marginPct/100)
  breakEvenPerKm:   number;     // totalCost / kmTarget (cost recovery per km)
  minFreightPerKm:  number;     // minRevenue / kmTarget (incl. margin)

  // Actual vs budget (populated from expenseMap + route data)
  actualCostEur:    number;     // total costs from Kartoteka for this vehicle+month
  actualRevenueEur: number;     // total freight from TMS routes for this vehicle+month
  actualKm:         number;     // total km from TMS routes
  variance:         number;     // actualCostEur - totalCost (positive = overspend)
  variancePct:      number;
  revenueVariance:  number;     // actualRevenueEur - minRevenue
  revenueVariancePct: number;
  isGhostCost:      boolean;    // true when actualKm === 0 but actualCostEur > 0
}

// ── Route actuals (from TMS XLS parsing) ────────────────────
export interface RouteActual {
  vehicleReg:   string;
  yearMonth:    string;
  kmLaden:      number;
  kmEmpty:      number;
  freightEur:   number;
}

// ── Aggregate actuals per vehicle per month ──────────────────
export interface ActualSummary {
  totalKm:      number;
  freightEur:   number;
  routeCount:   number;
}

export type ActualMap = Map<string, Map<string, ActualSummary>>;

export function buildActualMap(routes: RouteActual[]): ActualMap {
  const map: ActualMap = new Map();
  for (const r of routes) {
    const reg = r.vehicleReg.toUpperCase().trim();
    if (!map.has(reg)) map.set(reg, new Map());
    const vMap = map.get(reg)!;
    if (!vMap.has(r.yearMonth)) vMap.set(r.yearMonth, { totalKm: 0, freightEur: 0, routeCount: 0 });
    const s = vMap.get(r.yearMonth)!;
    s.totalKm    += r.kmLaden + r.kmEmpty;
    s.freightEur += r.freightEur;
    s.routeCount += 1;
  }
  return map;
}

// ── Build budget for a single vehicle / month ────────────────
export function buildVehicleBudget(
  vehicle:     VehicleRecord,
  yearMonth:   string,
  settings:    BudgetSettings,
  expenseMap?: ExpenseMap,
  actualMap?:  ActualMap,
): VehicleBudget {
  const reg  = vehicle.registration.toUpperCase().trim();
  const type = vehicle.vehicle_type;

  // Fixed costs
  const leasingEurMo   = vehicle.leasing_eur_mo   ?? 0;
  const insuranceEurMo = vehicle.insurance_eur_mo  ?? 0;
  const fixedTotal     = leasingEurMo + insuranceEurMo;

  let kmTarget      = 0;
  let fuelEur       = 0;
  let adblueEur     = 0;
  let tollEur       = 0;
  let serviceEur    = 0;
  let driverEur     = 0;
  let variableTotal = 0;

  if (type === "tractor") {
    kmTarget = settings.kmTargetMo;

    // Fuel cost at target km
    const fuelL100 = settings.avgFuelL100;
    const fuelLiters = (fuelL100 / 100) * kmTarget;
    fuelEur    = fuelLiters * settings.fuelPriceEurL;
    adblueEur  = fuelLiters * (settings.adblueRatePct / 100) * 0.35;

    // Toll
    tollEur = settings.tollEurPerKm * kmTarget;

    // Service cost per km — umowa serwisowa pokrywa serwis stałą opłatą (zwykle w racie leasingu)
    const isNew      = (vehicle.year_produced ?? 0) >= 2022;
    const svcKm       = vehicle.service_contract
      ? 0
      : vehicle.service_cost_km ?? (isNew ? FLEET.serviceCostNewKm : FLEET.serviceCostOldKm);
    serviceEur       = svcKm * kmTarget;

    // Driver — based on target km converted to route days
    const routeDays = kmTarget / FLEET.driverKmPerDay;
    driverEur = routeDays * settings.driverDailyCost;

    variableTotal = fuelEur + adblueEur + tollEur + serviceEur + driverEur;
  }
  // For trailers: only fixed costs matter (no km target, no driver)

  const totalCost      = fixedTotal + variableTotal;
  const marginFactor   = 1 - (settings.budgetMarginPct / 100);
  const minRevenue     = marginFactor > 0 ? totalCost / marginFactor : totalCost;
  const breakEvenPerKm = kmTarget > 0 ? totalCost / kmTarget : 0;
  const minFreightPerKm = kmTarget > 0 ? minRevenue / kmTarget : 0;

  // Actuals from Kartoteka
  const actualCostEur = expenseMap ? getMonthTotal(expenseMap, reg, yearMonth) : 0;

  // Actuals from TMS routes
  const actualSummary = actualMap?.get(reg)?.get(yearMonth);
  const actualKm      = actualSummary?.totalKm    ?? 0;
  const actualRevenueEur = actualSummary?.freightEur ?? 0;

  const variance         = Math.round((actualCostEur - totalCost) * 100) / 100;
  const variancePct      = totalCost > 0 ? Math.round((variance / totalCost) * 10000) / 100 : 0;
  const revenueVariance  = Math.round((actualRevenueEur - minRevenue) * 100) / 100;
  const revenueVariancePct = minRevenue > 0 ? Math.round((revenueVariance / minRevenue) * 10000) / 100 : 0;

  return {
    registration:     reg,
    vehicleType:      type,
    yearMonth,
    leasingEurMo:     round2(leasingEurMo),
    insuranceEurMo:   round2(insuranceEurMo),
    fixedTotal:       round2(fixedTotal),
    kmTarget,
    fuelEur:          round2(fuelEur),
    adblueEur:        round2(adblueEur),
    tollEur:          round2(tollEur),
    serviceEur:       round2(serviceEur),
    driverEur:        round2(driverEur),
    variableTotal:    round2(variableTotal),
    totalCost:        round2(totalCost),
    minRevenue:       round2(minRevenue),
    breakEvenPerKm:   round2(breakEvenPerKm),
    minFreightPerKm:  round2(minFreightPerKm),
    actualCostEur:    round2(actualCostEur),
    actualRevenueEur: round2(actualRevenueEur),
    actualKm,
    variance,
    variancePct,
    revenueVariance,
    revenueVariancePct,
    isGhostCost: actualCostEur > 0 && actualKm === 0,
  };
}

// ── Build budgets for full fleet / all months ────────────────
export interface FleetBudgetResult {
  tractorBudgets:  VehicleBudget[];
  trailerBudgets:  VehicleBudget[];
  ghostCosts:      VehicleBudget[];    // vehicles with costs but zero km
  months:          string[];           // all months in scope
  summaryByMonth:  MonthSummary[];
}

export interface MonthSummary {
  yearMonth:        string;
  tractorCount:     number;
  trailerCount:     number;
  budgetCostEur:    number;   // planned total fleet cost
  budgetRevenueEur: number;   // planned min revenue
  actualCostEur:    number;   // actual costs from Kartoteka
  actualRevenueEur: number;   // actual freight from TMS
  actualKm:         number;
  budgetKm:         number;   // sum of km targets
  costVariance:     number;
  revenueVariance:  number;
}

export function buildFleetBudget(
  vehicles:    VehicleRecord[],
  months:      string[],
  settings:    BudgetSettings,
  expenseMap?: ExpenseMap,
  actualMap?:  ActualMap,
): FleetBudgetResult {
  const tractorBudgets: VehicleBudget[] = [];
  const trailerBudgets: VehicleBudget[] = [];

  for (const v of vehicles) {
    if (v.vehicle_type === "van") continue; // skip vans

    for (const m of months) {
      const b = buildVehicleBudget(v, m, settings, expenseMap, actualMap);
      if (v.vehicle_type === "tractor") tractorBudgets.push(b);
      else trailerBudgets.push(b);
    }
  }

  // Ghost costs: any vehicle with cost in Kartoteka but zero TMS km in that month
  const ghostCosts = [...tractorBudgets, ...trailerBudgets].filter(b => b.isGhostCost);

  // Monthly summaries
  const summaryByMonth: MonthSummary[] = months.map(m => {
    const tBudgets = tractorBudgets.filter(b => b.yearMonth === m);
    const rBudgets = trailerBudgets.filter(b => b.yearMonth === m);
    const all      = [...tBudgets, ...rBudgets];

    return {
      yearMonth:        m,
      tractorCount:     tBudgets.length,
      trailerCount:     rBudgets.length,
      budgetCostEur:    round2(all.reduce((s, b) => s + b.totalCost, 0)),
      budgetRevenueEur: round2(tBudgets.reduce((s, b) => s + b.minRevenue, 0)), // revenue only for tractors
      actualCostEur:    round2(all.reduce((s, b) => s + b.actualCostEur, 0)),
      actualRevenueEur: round2(all.reduce((s, b) => s + b.actualRevenueEur, 0)),
      actualKm:         tBudgets.reduce((s, b) => s + b.actualKm, 0),
      budgetKm:         tBudgets.reduce((s, b) => s + b.kmTarget, 0),
      costVariance:     round2(all.reduce((s, b) => s + b.variance, 0)),
      revenueVariance:  round2(all.reduce((s, b) => s + b.revenueVariance, 0)),
    };
  });

  return { tractorBudgets, trailerBudgets, ghostCosts, months, summaryByMonth };
}

// ── Fleet ghost cost analysis (vehicles with costs but no routes) ─
export interface GhostVehicleSummary {
  registration:   string;
  vehicleType:    "tractor" | "trailer";
  activeMonths:   string[];       // months with any Kartoteka cost
  firstCostMonth: string;
  lastCostMonth:  string;
  totalCostEur:   number;
  monthlyAvgEur:  number;
  leasingEurMo:   number;
  insuranceEurMo: number;
  details:        Array<{ yearMonth: string; costEur: number }>;
}

export function analyzeGhostVehicles(
  vehicles:   VehicleRecord[],
  months:     string[],
  expenseMap: ExpenseMap,
  actualMap:  ActualMap,
): GhostVehicleSummary[] {
  const results: GhostVehicleSummary[] = [];

  for (const v of vehicles) {
    if (v.vehicle_type === "van") continue;
    const reg = v.registration.toUpperCase().trim();

    const details: Array<{ yearMonth: string; costEur: number }> = [];

    for (const m of months) {
      const costEur = getMonthTotal(expenseMap, reg, m);
      const km      = actualMap.get(reg)?.get(m)?.totalKm ?? 0;
      if (costEur > 0 && km === 0) {
        details.push({ yearMonth: m, costEur });
      }
    }

    if (details.length === 0) continue;

    const activeMonths   = details.map(d => d.yearMonth).sort();
    const totalCostEur   = round2(details.reduce((s, d) => s + d.costEur, 0));
    const monthlyAvgEur  = round2(totalCostEur / details.length);

    results.push({
      registration:   reg,
      vehicleType:    v.vehicle_type as "tractor" | "trailer",
      activeMonths,
      firstCostMonth: activeMonths[0],
      lastCostMonth:  activeMonths[activeMonths.length - 1],
      totalCostEur,
      monthlyAvgEur,
      leasingEurMo:   v.leasing_eur_mo   ?? 0,
      insuranceEurMo: v.insurance_eur_mo  ?? 0,
      details,
    });
  }

  return results.sort((a, b) => b.totalCostEur - a.totalCostEur);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
