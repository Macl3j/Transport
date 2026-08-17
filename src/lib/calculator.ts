// ============================================================
// TruckCalc HBM — Core Calculation Engine
// All monetary values in EUR
// Based on fleet analysis: 67 tractors, 5,180,419 km, 2024-2025
// ============================================================

export interface RouteInput {
  originCountry: string;           // ISO-2
  destCountry: string;             // ISO-2
  distanceKm: number;              // km ładowne (loaded km) — for revenue/km display
  emptyKm?: number;                // km puste (deadhead/empty run) — added to cost base
  fuelPriceEurL: number;           // default 1.25
  vehicleReg?: string;
  avgFuelL100?: number;            // override; default fleet avg 29.62
  freightEur: number;
  transitCountries?: string[];     // incl. origin & dest for toll calc
  overrideTollEur?: number;        // from ORS real-route calculation (replaces matrix)
  leasingEurMo?: number;           // vehicle-specific netto EUR/mo (tractor)
  trailerLeasingEurMo?: number;    // naczepa leasing EUR/mo (from fleet pairing or avg)
  insuranceEurMo?: number;         // OC+AC EUR/mo per vehicle (from Supabase)
  serviceCostKmOverride?: number;  // EUR/km override per vehicle (from Supabase)
  avgKmPerMonthActual?: number;    // DEPRECATED — kept for backward compat, ignored if routeDays provided
  routeDays?: number;              // actual route duration in days (from TMS dates or ceil(km/570))
  vehicleYearProduced?: number;    // for service cost tier
  avoidHighways?: boolean;
  // Udział w kosztach dziennych (0–1). Używane gdy ciągnik realizuje >1 zlecenie tego samego dnia.
  // Proporcjonalny do km: zlecenie 180km z 480km łącznie → 0.375 (37.5% dniówki).
  // Wpływa na: kierowca, leasing per_dobe, ubezpieczenie per_dobe.
  // Koszty per km (paliwo, myto, serwis) — bez zmian.
  perDobeShareFactor?: number;     // default 1.0 (pełna dniówka)
}

export interface CostBreakdown {
  fuel: number;
  adblue: number;
  toll: number;
  insurance: number;
  driver: number;
  leasing: number;        // tractor leasing
  trailerLeasing: number; // naczepa leasing
  service: number;
  idle: number;
  total: number;
  marginEur: number;
  marginPct: number;
  minProfitableFreight: number;
  // per-km summary
  costPerKm: number;
  revenuePerKm: number;
  // route info
  routeDays: number;   // doby trasy użyte w kalkulacji
  euroClass: number;
}

// ─── Fleet constants (from our data analysis) ────────────────
export const FLEET = {
  avgFuelL100:          27.80,    // Trimble FMS, 55 vehicles, Jan-May 2026
  // ── Driver + administration cost ────────────────────────────
  // Model A (fixed monthly): 4 700 EUR brutto/mies. (agencja pracy, z VAT 23%)
  //   → netto = 4 700 / 1.23 = 3 821 EUR/mies.
  //   → per km = 3 821 / actual_km_month (per vehicle from Supabase avg_km_month)
  // Model B (flat per km):   0.39 EUR/km  ← accepted rate niezależnie od km/mies.
  //   Both models give similar results at ~9 800 km/mies.
  driverCostEurMoGross:  4_700,   // EUR brutto (agencja pracy + VAT 23%)
  driverCostEurMoNet:    3_821,   // EUR netto (po odliczeniu VAT)
  driverCostPerKmFlat:   0.39,    // EUR/km — flat rate fallback only
  // ── Model dobowy (rekomendowany) ─────────────────────────────
  // 3821 EUR netto / 21 dni roboczych = 181.95 EUR/dobę
  // Doby trasy = z dat TMS lub ceil(km/570 km/dobę — dane rzeczywiste floty HBM)
  driverWorkDaysPerMonth: 21,     // dni robocze TIR/mies. (po odpoczynkach tygodniowych)
  driverDailyCostNet:     181.95, // 3821 / 21 = 181.95 EUR/dobę
  driverKmPerDay:         570,    // śr. km/dobę flota HBM (9h × ~63 km/h śr.) — dane rzeczywiste
  serviceCostNewKm:          0.009,    // MAN TGX 2023-2024
  serviceCostOldKm:          0.020,    // MAN TGX 2018-2019, DAF XF 2019
  leasingNewEurMo:           733.33,   // ciągnik ≥2022 ~8 800 EUR/yr
  leasingOldEurMo:           520.83,   // ciągnik <2022  ~6 250 EUR/yr
  // Naczepa leasing fallback (used when no fleet naczepa data available)
  trailerLeasingNewEurMo:    458.33,   // naczepa ≥2020 ~5 500 EUR/yr
  trailerLeasingOldEurMo:    333.33,   // naczepa <2020  ~4 000 EUR/yr
  avgKmPerMonth:        11_667,   // 140k km/yr fleet default (used if vehicle-specific unknown)
  idleFuelPct:          0.021,    // 2.1% idle losses (Trimble FMS Jan-May 2026)
  adblueRatePct:        0.035,    // AdBlue = 3.5% of diesel volume
  // Insurance default: avg fleet (OC 6531 PLN + AC 3053 PLN @ 4.25 PLN/EUR) / 12
  insuranceEurMo:       188.0,    // EUR/mies. fleet avg OC+AC
} as const;

// ─── Toll matrix EUR/100km (calibrated from real TMS fleet data 2025-2026) ─
// Source: actual DKV/viaTOLL invoices cross-referenced with TMS route segments
// PL: ViaTOLL HGV avg 0.13 EUR/km (was 0.042 — grossly underestimated)
// DE: Autobahn Maut EURO VI ~0.30-0.34 EUR/km avg (was 0.185)
// CZ: Czech toll HGV avg ~0.20 EUR/km (was 0.08)
// FR: Autoroutes HGV avg ~0.30 EUR/km (small sample — may be adjusted)
export const TOLL_MATRIX: Record<string, number> = {
  PL: 13.00,
  DE: 30.00,
  FR: 30.00,
  IT: 27.00,
  ES: 14.00,
  AT: 22.00,
  CZ: 20.00,
  HU: 12.00,
  NL: 14.00,
  BE: 15.00,
  LU: 11.00,
  CH: 38.00,
  SI: 18.00,
  HR: 18.00,
  SK: 14.00,
  RO:  8.00,
  BG:  6.00,
  PT: 18.00,
  SE: 12.00,
  DK: 13.00,
};

// ─── EURO class derivation from vehicle year ──────────────────
// Tractor + semi-trailer (5 axles) — standard HBM fleet configuration
export function euroClass(year: number): 3 | 4 | 5 | 6 {
  if (year >= 2014) return 6;
  if (year >= 2009) return 5;
  if (year >= 2006) return 4;
  return 3;
}

// Per-country toll multiplier vs EURO VI baseline
// Countries where EURO class significantly affects toll rates
// DE: Autobahn Maut (5 axles): VI=0.288, V=0.329, IV=0.390 EUR/km
// AT: GO-Maut: VI≈1.0, V≈1.12, IV≈1.25 relative
// CH: LSVA: depends on emission class — smaller spread
const EURO_MULTIPLIER: Record<number, Record<string, number>> = {
  6: { DE: 1.00, AT: 1.00, CH: 1.00 },  // baseline (TOLL_MATRIX uses EURO VI rates)
  5: { DE: 1.14, AT: 1.12, CH: 1.05 },
  4: { DE: 1.35, AT: 1.25, CH: 1.10 },
  3: { DE: 1.57, AT: 1.40, CH: 1.15 },
};

// ─── Calc settings (from /konfiguracja, stored in Supabase) ──────────────────
export interface CalcSettings {
  leasingMethod:        'per_dobe' | 'per_km';  // alokacja leasing ciągnika
  trailerLeasingMethod: 'per_dobe' | 'per_km';  // alokacja leasing naczepy
  insuranceMethod:      'per_dobe' | 'per_km';  // alokacja ubezpieczenie
  avgFuelL100?:      number;  // spalanie flotowe (nadpisuje FLEET)
  driverDailyCost?:  number;  // koszt kierowcy EUR/dobę
  adblueRatePct?:    number;  // AdBlue % paliwa
  idleFuelPct?:      number;  // bieg jałowy % paliwa
  avgKmPerMonth?:    number;  // km/miesiąc fallback
  marginGoodPct?:    number;  // >= rentowna (%)
  marginLowPct?:     number;  // >= niska marża (%)
}

export const DEFAULT_CALC_SETTINGS: CalcSettings = {
  leasingMethod:        'per_km',
  trailerLeasingMethod: 'per_km',
  insuranceMethod:      'per_km',
};

// ─── Main calculation ─────────────────────────────────────────
export function calculateRoute(input: RouteInput, settings?: CalcSettings): CostBreakdown {
  const {
    distanceKm,
    fuelPriceEurL,
    freightEur,
    transitCountries,
    originCountry,
    destCountry,
    leasingEurMo,
    vehicleYearProduced,
  } = input;

  const s = settings ?? DEFAULT_CALC_SETTINGS;
  const fleetAvgKmMo = s.avgKmPerMonth ?? FLEET.avgKmPerMonth;

  const fuelL100 = input.avgFuelL100 ?? s.avgFuelL100 ?? FLEET.avgFuelL100;

  // Total km driven = loaded km + empty km (deadhead)
  // Empty km increases fuel/service costs but generates no revenue
  const totalKm = distanceKm + (input.emptyKm ?? 0);

  // 1. FUEL — l/100km × TOTAL km (loaded + empty)
  const fuelLiters = (fuelL100 / 100) * totalKm;
  const fuelCost   = fuelLiters * fuelPriceEurL;

  // 2. ADBLUE — FLEET.adblueRatePct is decimal (0.035), settings stores percent (3.5)
  const adblueRate = s.adblueRatePct != null
    ? s.adblueRatePct / 100
    : FLEET.adblueRatePct;
  const adblue = fuelLiters * adblueRate * 0.35;

  // 3. IDLE FUEL LOSSES — FLEET.idleFuelPct is decimal (0.021), settings stores percent (2.1)
  const idlePct = s.idleFuelPct != null
    ? s.idleFuelPct / 100
    : FLEET.idleFuelPct;
  const idle = fuelCost * idlePct;

  // 4. TOLLS — use ORS real-route value if available, else matrix with EURO class adjustment
  const euro = vehicleYearProduced ? euroClass(vehicleYearProduced) : 6;
  const euroMult = EURO_MULTIPLIER[euro] ?? EURO_MULTIPLIER[6];

  let tollCost: number;
  if (input.overrideTollEur != null && input.overrideTollEur > 0) {
    // Realne myto z TMS — użyj wprost, bez dopisywania "korekty powrotu".
    // Wcześniejsza wersja mnożyła overrideTollEur przez (emptyKm / distanceKm),
    // zakładając że pusty przejazd to ta sama trasa co ładowna — przy dużej
    // dysproporcji (np. 87 km ładownych / 337 km pustych) dawało to absurdalne
    // zawyżenie (98,53 EUR -> 480,19 EUR, +387%), systematycznie zaniżając
    // pokazywaną rentowność tras z długim pustym przejazdem po krótkiej dostawie.
    tollCost = input.overrideTollEur;
  } else {
    const countries = transitCountries && transitCountries.length > 0
      ? transitCountries
      : [originCountry, destCountry];
    const uniqueCountries = Array.from(new Set(countries));
    // Apply per-country EURO class multiplier
    const tollRates = uniqueCountries.map(c => {
      const base = TOLL_MATRIX[c] ?? 13.0;
      const mult = euroMult[c] ?? 1.0;
      return base * mult;
    });
    const avgToll = tollRates.reduce((a, b) => a + b, 0) / tollRates.length;
    // Use totalKm (laden + empty) — truck pays toll both ways
    tollCost = (avgToll / 100) * totalKm;
  }

  // 5. DRIVER — Model Dobowy
  const routeDays = input.routeDays && input.routeDays > 0
    ? input.routeDays
    : Math.max(1, Math.ceil(distanceKm / FLEET.driverKmPerDay));
  // Udział w dniówce: <1.0 gdy ciągnik ma kilka zleceń tego dnia (proporcja km)
  const perDobeShare = input.perDobeShareFactor ?? 1.0;
  const dailyCost = s.driverDailyCost ?? FLEET.driverDailyCostNet;
  const driverCost = routeDays * dailyCost * perDobeShare;

  // 6. SERVICE — per-vehicle override (from Supabase) or fleet tier (new/old)
  // Uses totalKm (loaded + empty) — service/wear applies to all km driven
  const isNewVehicle = vehicleYearProduced ? vehicleYearProduced >= 2022 : false;
  const serviceCostKm = input.serviceCostKmOverride
    ?? (isNewVehicle ? FLEET.serviceCostNewKm : FLEET.serviceCostOldKm);
  const serviceCost = serviceCostKm * totalKm;

  // 7a. LEASING CIĄGNIKA
  const leasingMo = leasingEurMo
    ?? (isNewVehicle ? FLEET.leasingNewEurMo : FLEET.leasingOldEurMo);
  const leasingCost = s.leasingMethod === 'per_dobe'
    ? (leasingMo / 30) * routeDays * perDobeShare
    : (leasingMo / fleetAvgKmMo) * distanceKm;

  // 7b. LEASING NACZEPY
  const trailerLeasingMo = input.trailerLeasingEurMo
    ?? (isNewVehicle ? FLEET.trailerLeasingNewEurMo : FLEET.trailerLeasingOldEurMo);
  const trailerLeasingCost = s.trailerLeasingMethod === 'per_dobe'
    ? (trailerLeasingMo / 30) * routeDays * perDobeShare
    : (trailerLeasingMo / fleetAvgKmMo) * distanceKm;

  // 8. INSURANCE (OC+AC)
  const insuranceMo = input.insuranceEurMo ?? FLEET.insuranceEurMo;
  const insuranceCost = s.insuranceMethod === 'per_dobe'
    ? (insuranceMo / 30) * routeDays * perDobeShare
    : (insuranceMo / fleetAvgKmMo) * distanceKm;

  // ─── Totals ───────────────────────────────────────────────
  const total = fuelCost + adblue + idle + tollCost + driverCost + serviceCost + leasingCost + trailerLeasingCost + insuranceCost;

  const marginEur = freightEur - total;
  const marginPct = freightEur > 0 ? (marginEur / freightEur) * 100 : 0;

  // Break-even freight = total costs / (1 - desired margin buffer 0%)
  const minProfitableFreight = total;

  const costPerKm    = total / distanceKm;
  const revenuePerKm = freightEur / distanceKm;

  return {
    fuel:    round2(fuelCost),
    adblue:  round2(adblue),
    idle:    round2(idle),
    toll:    round2(tollCost),
    driver:  round2(driverCost),
    service:        round2(serviceCost),
    leasing:        round2(leasingCost),
    trailerLeasing: round2(trailerLeasingCost),
    insurance:      round2(insuranceCost),
    total:     round2(total),
    marginEur:             round2(marginEur),
    marginPct:             round2(marginPct),
    minProfitableFreight:  round2(minProfitableFreight),
    costPerKm:             round2(costPerKm),
    revenuePerKm:          round2(revenuePerKm),
    routeDays,
    euroClass:             euro,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Helpers ──────────────────────────────────────────────────
export function profitabilityLabel(
  marginPct: number,
  goodPct = 15,
  lowPct  = 5,
): { label: string; color: string } {
  if (marginPct >= goodPct) return { label: "Rentowna",          color: "emerald" };
  if (marginPct >= lowPct)  return { label: "Niska marża",       color: "amber"   };
  if (marginPct >= 0)       return { label: "Próg rentowności",  color: "orange"  };
  return                           { label: "STRATA",            color: "red"     };
}

export function countryName(iso: string): string {
  const map: Record<string, string> = {
    PL: "Polska", DE: "Niemcy", FR: "Francja", IT: "Włochy",
    ES: "Hiszpania", AT: "Austria", CZ: "Czechy", HU: "Węgry",
    NL: "Holandia", BE: "Belgia", LU: "Luksemburg", CH: "Szwajcaria",
    SI: "Słowenia", HR: "Chorwacja", SK: "Słowacja", RO: "Rumunia",
    BG: "Bułgaria", PT: "Portugalia", SE: "Szwecja", DK: "Dania",
    GB: "Wielka Brytania",
  };
  return map[iso] ?? iso;
}

export const COUNTRY_OPTIONS = Object.entries({
  PL: "Polska", DE: "Niemcy", FR: "Francja", IT: "Włochy",
  ES: "Hiszpania", AT: "Austria", CZ: "Czechy", HU: "Węgry",
  NL: "Holandia", BE: "Belgia", LU: "Luksemburg", CH: "Szwajcaria",
  SI: "Słowenia", HR: "Chorwacja", SK: "Słowacja", RO: "Rumunia",
  BG: "Bułgaria", PT: "Portugalia", SE: "Szwecja", DK: "Dania",
}).map(([iso, name]) => ({ iso, name }));
