// ============================================================
// cycleAnalyzer.ts — HBM TruckCalc
// Grupuje trasy TMS w "kółka" (cykle PL → zagranica → PL)
// Wykrywa flat-rate orders (1km za kilkaset EUR)
// ============================================================

// ── Minimal route interface (spełniany przez RouteMetric) ─────
export interface CycleRouteInput {
  orderNr:            string;
  vehicle:            string;       // rejestracja ciągnika
  label:              string;
  client?:            string;
  originCountry:      string;       // "PL", "DE", "CZ" …
  destCountry:        string;
  distanceKm:         number;       // km ładowne
  emptyKm?:           number;       // km puste
  totalKm:            number;
  frachtEur:          number;
  totalCost:          number;
  marginEur:          number;
  marginPct:          number;
  routeDays:          number;
  tripDate:           string;       // "YYYY-MM-DD"
  deliveryDate:       string;       // "YYYY-MM-DD"
  tripTimestamp?:     number;       // Unix ms (opcjonalnie — dokładność godzinowa)
  deliveryTimestamp?: number;       // Unix ms
  driverName?:        string;
  // Do kosztu postoju (przerwy do następnej trasy tego pojazdu) — liczone jak w /dyspozytorzy
  fixedCostPerDayEur?:  number;     // (leasing ciągnika + naczepy + ubezpieczenie) / doby trasy
  driverCostPerDayEur?: number;     // stawka doby kierowcy z /konfiguracja
}

// ── Trasa wewnątrz cyklu ──────────────────────────────────────
export interface CycleRoute {
  orderNr:        string;
  tripDate:       string;
  deliveryDate:   string;
  label:          string;
  client:         string;
  originCountry:  string;
  destCountry:    string;
  distanceKm:     number;
  emptyKm:        number;
  totalKm:        number;
  frachtEur:      number;
  totalCost:      number;
  marginEur:      number;
  marginPct:      number;
  routeDays:      number;
  driverName:     string;
  isFlatRate:     boolean;  // km ≤ flatRateKmMax && fracht ≥ flatRateMinEur
  gapDaysAfter:   number;   // przerwa po tej trasie (w ramach cyklu)
  idleCostAfterEur: number; // koszt tej przerwy (kierowca + leasing + ubezpieczenie)
}

// ── Jedno kółko (pełny cykl za granicą) ─────────────────────
export interface TruckCycle {
  vehicleReg:     string;
  cycleIndex:     number;         // 1-based numer cyklu dla tego pojazdu
  startDate:      string;         // data wyjazdu (pickup pierwszej trasy)
  endDate:        string;         // data powrotu (delivery ostatniej trasy)
  durationDays:   number;         // startDate → endDate (dni)
  pauseDaysAfter: number;         // przerwa w Polsce po tym cyklu (przed następnym)
  routes:         CycleRoute[];
  routeCount:     number;
  flatRateCount:  number;

  // Km
  totalKmLaden:   number;
  totalKmEmpty:   number;
  totalKm:        number;

  // Przychody
  totalFreightEur:    number;
  regularFreightEur:  number;
  flatRateFreightEur: number;

  // Koszty (suma totalCost tras)
  totalCostEur:   number;

  // Postoje — jak w /dyspozytorzy: przerwa × (kierowca + leasing + ubezpieczenie) na dobę,
  // tylko dla par tras tego samego pojazdu z tego samego miesiąca (miesiąc = data podjęcia)
  idleCostEur:       number;   // przerwy między trasami wewnątrz kółka
  pauseCostAfterEur: number;   // przerwa po kółku (przed następnym)
  realMarginEur:     number;   // marża tras − postoje
  realMarginPct:     number;

  // Rentowność
  marginEur:      number;
  marginPct:      number;
  revenuePerDay:  number;   // totalFreight / durationDays
  costPerKm:      number;   // totalCost / totalKm
  revenuePerKm:   number;   // totalFreight / totalKmLaden (tylko ładowne)
}

// ── Parametry detekcji ────────────────────────────────────────
export interface CycleOptions {
  /** Minimalna przerwa w Polsce żeby uznać granicę cyklu (dni, domyślnie 0.25 = 6h) */
  minBreakDays?:    number;
  /** km ≤ N → potencjalny flat-rate order (domyślnie 5) */
  flatRateKmMax?:   number;
  /** fracht ≥ N EUR → potwierdzenie flat-rate (domyślnie 50) */
  flatRateMinEur?:  number;
}

// ── Helper: gap w dniach między dwiema trasami ────────────────
function gapDays(prev: CycleRouteInput, next: CycleRouteInput): number {
  // Jeśli mamy timestampy → precyzja godzinowa
  if (prev.deliveryTimestamp && next.tripTimestamp) {
    return (next.tripTimestamp - prev.deliveryTimestamp) / 86_400_000;
  }
  // Fallback → różnica dat (całe dni)
  const d1 = new Date(prev.deliveryDate);
  const d2 = new Date(next.tripDate);
  return (d2.getTime() - d1.getTime()) / 86_400_000;
}

// ── Helper: koszt przerwy między dwiema trasami (ta sama reguła co w /dyspozytorzy) ──
function idleCostBetween(prev: CycleRouteInput, next: CycleRouteInput): number {
  const gap = gapDays(prev, next);
  if (gap <= 0) return 0;
  // Pary z różnych miesięcy (wg daty podjęcia) nie są liczone — jak w /dyspozytorzy
  if (prev.tripDate.slice(0, 7) !== next.tripDate.slice(0, 7)) return 0;
  const driverChanged = !!(prev.driverName && next.driverName && prev.driverName !== next.driverName);
  const servicePl = gap > 2 && prev.destCountry.toUpperCase() === "PL";
  const driverRate = (driverChanged || servicePl) ? 0 : (prev.driverCostPerDayEur ?? 0);
  return round2(gap * (driverRate + (prev.fixedCostPerDayEur ?? 0)));
}

// ── Helper: czy to przerwa PL → PL (koniec cyklu) ─────────────
function isCycleBreak(
  prev: CycleRouteInput,
  next: CycleRouteInput,
  minBreakDays: number,
): boolean {
  const gap = gapDays(prev, next);
  const prevInPl = prev.destCountry.toUpperCase() === "PL";
  const nextFromPl = next.originCountry.toUpperCase() === "PL";
  return gap >= minBreakDays && prevInPl && nextFromPl;
}

// ── Główna funkcja analizy ────────────────────────────────────
export function analyzeCycles(
  routes: CycleRouteInput[],
  opts: CycleOptions = {},
): TruckCycle[] {
  const {
    minBreakDays  = 0.25,   // 6 godzin
    flatRateKmMax = 5,
    flatRateMinEur = 50,
  } = opts;

  // Grupuj po pojeździe
  const byVehicle = new Map<string, CycleRouteInput[]>();
  for (const r of routes) {
    const key = r.vehicle.toUpperCase().trim();
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key)!.push(r);
  }

  const allCycles: TruckCycle[] = [];

  for (const [vehicleReg, vehicleRoutes] of byVehicle) {
    // Sortuj chronologicznie
    const sorted = [...vehicleRoutes].sort((a, b) =>
      a.tripDate.localeCompare(b.tripDate)
    );

    // Podziel na cykle
    const cycleGroups: CycleRouteInput[][] = [];
    let current: CycleRouteInput[] = [];

    for (let i = 0; i < sorted.length; i++) {
      current.push(sorted[i]);
      const next = sorted[i + 1];
      if (!next || isCycleBreak(sorted[i], next, minBreakDays)) {
        cycleGroups.push(current);
        current = [];
      }
    }
    if (current.length > 0) cycleGroups.push(current);

    // Konwertuj grupy → TruckCycle
    for (let ci = 0; ci < cycleGroups.length; ci++) {
      const group = cycleGroups[ci];
      const nextGroup = cycleGroups[ci + 1];

      // Gap po tym cyklu (przerwa w Polsce)
      const lastInGroup = group[group.length - 1];
      const firstInNext = nextGroup?.[0];
      const pauseAfter = firstInNext
        ? Math.max(0, gapDays(lastInGroup, firstInNext))
        : 0;
      const pauseCostAfter = firstInNext ? idleCostBetween(lastInGroup, firstInNext) : 0;

      // Zbuduj CycleRoute[]
      const cycleRoutes: CycleRoute[] = group.map((r, ri) => {
        const nextR = group[ri + 1];
        const gapAfter = nextR ? Math.max(0, gapDays(r, nextR)) : 0;
        const idleAfter = nextR ? idleCostBetween(r, nextR) : 0;
        const isFlatRate = r.distanceKm <= flatRateKmMax && r.frachtEur >= flatRateMinEur;
        return {
          orderNr:      r.orderNr,
          tripDate:     r.tripDate,
          deliveryDate: r.deliveryDate,
          label:        r.label,
          client:       r.client ?? "—",
          originCountry: r.originCountry,
          destCountry:  r.destCountry,
          distanceKm:   r.distanceKm,
          emptyKm:      r.emptyKm ?? 0,
          totalKm:      r.totalKm,
          frachtEur:    r.frachtEur,
          totalCost:    r.totalCost,
          marginEur:    r.marginEur,
          marginPct:    r.marginPct,
          routeDays:    r.routeDays,
          driverName:   r.driverName ?? "—",
          isFlatRate,
          gapDaysAfter: round2(gapAfter),
          idleCostAfterEur: idleAfter,
        };
      });

      const flatRoutes    = cycleRoutes.filter(r => r.isFlatRate);
      const regularRoutes = cycleRoutes.filter(r => !r.isFlatRate);

      const totalKmLaden      = round2(cycleRoutes.reduce((s, r) => s + r.distanceKm, 0));
      const totalKmEmpty      = round2(cycleRoutes.reduce((s, r) => s + r.emptyKm, 0));
      const totalKm           = round2(cycleRoutes.reduce((s, r) => s + r.totalKm, 0));
      const totalFreightEur   = round2(cycleRoutes.reduce((s, r) => s + r.frachtEur, 0));
      const regularFreightEur = round2(regularRoutes.reduce((s, r) => s + r.frachtEur, 0));
      const flatRateFreightEur= round2(flatRoutes.reduce((s, r) => s + r.frachtEur, 0));
      const totalCostEur      = round2(cycleRoutes.reduce((s, r) => s + r.totalCost, 0));
      const marginEur         = round2(totalFreightEur - totalCostEur);
      const marginPct         = totalFreightEur > 0
        ? round2((marginEur / totalFreightEur) * 100) : 0;
      const idleCostEur       = round2(cycleRoutes.reduce((s, r) => s + r.idleCostAfterEur, 0));
      const realMarginEur     = round2(marginEur - idleCostEur - pauseCostAfter);
      const realMarginPct     = totalFreightEur > 0
        ? round2((realMarginEur / totalFreightEur) * 100) : 0;

      const startDate = group[0].tripDate;
      const endDate   = lastInGroup.deliveryDate;
      const d1 = new Date(startDate);
      const d2 = new Date(endDate);
      const durationDays = Math.max(1, round2((d2.getTime() - d1.getTime()) / 86_400_000));

      allCycles.push({
        vehicleReg,
        cycleIndex:       ci + 1,
        startDate,
        endDate,
        durationDays,
        pauseDaysAfter:   round2(pauseAfter),
        routes:           cycleRoutes,
        routeCount:       cycleRoutes.length,
        flatRateCount:    flatRoutes.length,
        totalKmLaden,
        totalKmEmpty,
        totalKm,
        totalFreightEur,
        regularFreightEur,
        flatRateFreightEur,
        totalCostEur,
        idleCostEur,
        pauseCostAfterEur: round2(pauseCostAfter),
        realMarginEur,
        realMarginPct,
        marginEur,
        marginPct,
        revenuePerDay:    durationDays > 0 ? round2(totalFreightEur / durationDays) : 0,
        costPerKm:        totalKm > 0 ? round2(totalCostEur / totalKm) : 0,
        revenuePerKm:     totalKmLaden > 0 ? round2(totalFreightEur / totalKmLaden) : 0,
      });
    }
  }

  // Sortuj: pojazd → numer cyklu
  return allCycles.sort((a, b) =>
    a.vehicleReg.localeCompare(b.vehicleReg) || a.cycleIndex - b.cycleIndex
  );
}

// ── Podsumowanie floty ────────────────────────────────────────
export interface FleetCycleSummary {
  totalCycles:          number;
  totalRoutes:          number;
  totalFlatRateRoutes:  number;
  totalKm:              number;
  totalFreightEur:      number;
  totalCostEur:         number;
  totalMarginEur:       number;
  totalIdleCostEur:     number;   // postoje (w kółkach i po kółkach)
  totalRealMarginEur:   number;   // marża tras − postoje
  realMarginPct:        number;
  avgMarginPct:         number;
  avgDurationDays:      number;
  avgFreightPerCycle:   number;
  avgKmPerCycle:        number;
}

export function fleetCycleSummary(cycles: TruckCycle[]): FleetCycleSummary {
  if (cycles.length === 0) {
    return {
      totalCycles: 0, totalRoutes: 0, totalFlatRateRoutes: 0,
      totalKm: 0, totalFreightEur: 0, totalCostEur: 0,
      totalMarginEur: 0, totalIdleCostEur: 0, totalRealMarginEur: 0, realMarginPct: 0,
      avgMarginPct: 0, avgDurationDays: 0,
      avgFreightPerCycle: 0, avgKmPerCycle: 0,
    };
  }
  const n = cycles.length;
  const totalFreightEur = round2(cycles.reduce((s, c) => s + c.totalFreightEur, 0));
  const totalCostEur    = round2(cycles.reduce((s, c) => s + c.totalCostEur, 0));
  const totalMarginEur  = round2(totalFreightEur - totalCostEur);
  const totalIdleCostEur = round2(cycles.reduce((s, c) => s + c.idleCostEur + c.pauseCostAfterEur, 0));
  const totalRealMarginEur = round2(totalMarginEur - totalIdleCostEur);
  return {
    totalCycles:         n,
    totalRoutes:         cycles.reduce((s, c) => s + c.routeCount, 0),
    totalFlatRateRoutes: cycles.reduce((s, c) => s + c.flatRateCount, 0),
    totalKm:             round2(cycles.reduce((s, c) => s + c.totalKm, 0)),
    totalFreightEur,
    totalCostEur,
    totalMarginEur,
    totalIdleCostEur,
    totalRealMarginEur,
    realMarginPct:       totalFreightEur > 0 ? round2((totalRealMarginEur / totalFreightEur) * 100) : 0,
    avgMarginPct:        totalFreightEur > 0 ? round2((totalMarginEur / totalFreightEur) * 100) : 0,
    avgDurationDays:     round2(cycles.reduce((s, c) => s + c.durationDays, 0) / n),
    avgFreightPerCycle:  round2(totalFreightEur / n),
    avgKmPerCycle:       round2(cycles.reduce((s, c) => s + c.totalKm, 0) / n),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
