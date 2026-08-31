"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { calculateRoute, FLEET } from "@/lib/calculator";
import { useSettings } from "@/lib/settings-context";

// ─── Types ────────────────────────────────────────────────────
interface Dispatcher {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
}

interface Vehicle {
  reg: string;
  brand: string | null;
  model: string | null;
  vehicle_type: string | null;
  dispatcher_id: string | null;
  avg_fuel_l100: number | null;
  year_produced: number | null;
  leasing_eur_mo: number | null;
  insurance_eur_mo: number | null;
  service_cost_km: number | null;
  avg_km_month: number | null;
}

interface CostBreakdownDetail {
  fuel: number; adblue: number; idle: number;
  toll: number; driver: number; service: number;
  leasing: number; trailerLeasing: number; insurance: number;
}

// ─── Monthly analysis types ───────────────────────────────────
interface RouteGap {
  prevRoute: RouteMetric;
  nextRoute: RouteMetric;
  idleDays: number;     // calendar days between delivery[n] and pickup[n+1]
  idleCostEur: number;  // idleDays × dailyFixedRate
  isServicePl: boolean; // pojazd w Polsce >2d — serwis, brak dobówki kierowcy
}

interface MonthlyVehicleSummary {
  vehicle: string;
  month: string;        // "2026-05"
  routes: RouteMetric[];
  gaps: RouteGap[];
  activeDays: number;   // Σ routeDays
  idleDays: number;     // Σ gap.idleDays
  idleCostEur: number;  // Σ gap.idleCostEur
  totalFreight: number;
  totalRouteCosts: number;   // includes fixed costs for active days
  trueMonthlyMargin: number; // totalFreight - totalRouteCosts - idleCostEur
  trueMarginPct: number;
  routeMarginSum: number;    // Σ route.marginEur (without idle correction)
  drivers: string[];         // unique driver names in this month
}

interface RouteMetric {
  orderNr: string;
  client: string;
  vehicle: string;
  dispatcher_id: string | null;
  dispatcherName: string;
  originCountry: string;
  destCountry: string;
  distanceKm: number;
  emptyKm?: number;
  totalKm: number;    // distanceKm + emptyKm (łącznie ładowne + puste)
  frachtEur: number;
  frachtEstimated: boolean;   // true when fracht=0 in TMS → estimated from margin/km
  noFreightData: boolean;     // true when fracht=0 AND no TMS margin — no invoice data at all
  totalCost: number;
  marginEur: number;
  marginPct: number;
  tollEur: number;
  label: string;
  breakdown: CostBreakdownDetail;
  costPerKm: number;
  revenuePerKm: number;
  routeDays: number;
  // Kontynuacja trasy — ten sam ciągnik, ten sam dzień
  isContinuation: boolean;
  perDobeShareFactor: number;
  tripDate: string;       // YYYY-MM-DD załadunek
  deliveryDate: string;   // YYYY-MM-DD dostarczenie (rzeczywiste > planowane)
  driverName: string;     // z kolumny "Kierowca 1"
  tripTimestamp?: number;      // Unix ms — dla ułamkowych gap calculations
  deliveryTimestamp?: number;  // Unix ms — dla ułamkowych gap calculations
}

interface DispatcherKPI {
  id: string;
  name: string;
  vehicles: string[];
  ciagniki: string[];
  naczepy: string[];
  routes: number;
  frachtEur: number;
  costEur: number;
  marginEur: number;
  marginPct: number;
  kmTotal: number;
  losses: number;
  lowMargin: number;
  breakeven: number;
  profitable: number;
  avgMarginPct: number;
  routeList: RouteMetric[];
}

// ─── Helpers ──────────────────────────────────────────────────
function fmtEur(n: number) { return n.toLocaleString("pl-PL", { maximumFractionDigits: 0 }) + " €"; }
function fmtPct(n: number) { return n.toFixed(1) + "%"; }
function marginColor(pct: number) {
  if (pct >= 15) return "text-emerald-600";
  if (pct >= 5)  return "text-amber-600";
  if (pct >= 0)  return "text-orange-600";
  return "text-red-600";
}

function parseFracht(s: string, eurRate: number): number {
  if (!s) return 0;
  const str = String(s).replace(/\s/g, "");
  const m = str.match(/([\d,.]+)([A-Z]{3})/);
  if (!m) return 0;
  const num = parseFloat(m[1].replace(",", "."));
  if (isNaN(num)) return 0;
  return m[2] === "PLN" ? num / eurRate : num;
}

function toDateKey(s: string): string {
  if (!s) return "";
  // Excel serial number
  const n = parseFloat(s);
  if (!isNaN(n) && n > 40000) {
    const d = new Date((n - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }
  // TMS format: "DD-MM-YYYY HH:MM" or "DD-MM-YYYY"
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  // ISO or other JS-parseable
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s.length >= 10 ? s.slice(0, 10) : "";
}

/** Difference in whole calendar days between two YYYY-MM-DD strings */
function daysBetween(a: string, b: string): number {
  if (!a || !b) return 0;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/** Parse TMS/Excel date string → Unix ms timestamp (zachowuje czas HH:MM dla ułamkowych dni) */
function toTimestamp(s: string): number | undefined {
  if (!s) return undefined;
  // Excel serial (z czasem w ułamku doby)
  const n = parseFloat(s);
  if (!isNaN(n) && n > 40000) return Math.round((n - 25569) * 86400 * 1000);
  // TMS: "DD-MM-YYYY HH:MM[:SS]" lub "DD-MM-YYYY"
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const iso = dmy[4]
      ? `${dmy[3]}-${dmy[2]}-${dmy[1]}T${dmy[4]}:${dmy[5]}:${dmy[6] ?? "00"}`
      : `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  // ISO lub inny format JS
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.getTime();
}

// ─── Main page ────────────────────────────────────────────────
export default function DyspozytorzyPage() {
  const { settings } = useSettings();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dispatchers, setDispatchers] = useState<Dispatcher[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [kpiData, setKpiData] = useState<DispatcherKPI[]>([]);
  const [monthlyData, setMonthlyData] = useState<MonthlyVehicleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"config" | "dashboard" | "routes" | "clients" | "monthly" | "idle">("dashboard");
  const [selectedDispatcher, setSelectedDispatcher] = useState<string | null>(null);
  const [weekLabel, setWeekLabel] = useState("");
  const [eurRate, setEurRate] = useState(4.27);
  const [fuelPrice, setFuelPrice] = useState(1.25);

  // Sync fuel price and EUR rate from settings when they load from Supabase
  useEffect(() => {
    if (settings.fuelPriceEurL) setFuelPrice(settings.fuelPriceEurL);
    if (settings.plnEurRate)    setEurRate(settings.plnEurRate);
  }, [settings.fuelPriceEurL, settings.plnEurRate]);
  // Filters
  const [vehicleTypeFilter, setVehicleTypeFilter] = useState<"all" | "ciągnik" | "naczepa">("all");
  const [configTypeFilter, setConfigTypeFilter] = useState<"all" | "ciągnik" | "naczepa">("all");
  const [routeSearch, setRouteSearch] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [clientSortKey, setClientSortKey] = useState<"name" | "routes" | "km" | "fracht" | "cost" | "margin" | "marginPct">("marginPct");
  const [clientSortDesc, setClientSortDesc] = useState(false);

  // Loss analysis modal
  const [analysisRoute, setAnalysisRoute] = useState<RouteMetric | null>(null);

  // Config state
  const [newDispName, setNewDispName] = useState("");
  const [newDispEmail, setNewDispEmail] = useState("");
  const [assigningVehicle, setAssigningVehicle] = useState<string | null>(null);

  useEffect(() => {
    loadData();
    // Default week label
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    setWeekLabel(`${weekStart.toLocaleDateString("pl-PL")} – ${weekEnd.toLocaleDateString("pl-PL")}`);
  }, []);

  async function loadData() {
    setLoading(true);
    const [{ data: disps }, { data: vehs }] = await Promise.all([
      supabase.from("dispatchers").select("*").eq("is_active", true).order("name"),
      supabase.from("vehicles").select("reg,brand,model,vehicle_type,dispatcher_id,avg_fuel_l100,year_produced,leasing_eur_mo,insurance_eur_mo,service_cost_km,avg_km_month").eq("is_active", true).order("vehicle_type,reg"),
    ]);
    setDispatchers(disps ?? []);
    setVehicles(vehs ?? []);
    setLoading(false);
  }

  async function addDispatcher() {
    if (!newDispName.trim()) return;
    await supabase.from("dispatchers").insert({ name: newDispName.trim(), email: newDispEmail.trim() || null });
    setNewDispName(""); setNewDispEmail("");
    await loadData();
  }

  async function assignVehicle(reg: string, dispatcherId: string | null) {
    await supabase.from("vehicles").update({ dispatcher_id: dispatcherId }).eq("reg", reg);
    setAssigningVehicle(null);
    await loadData();
  }

  // ─── TMS Upload & Analysis ───────────────────────────────────
  async function handleTmsUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAnalysisLoading(true);

    const ab = await file.arrayBuffer();
    const wb = XLSX.read(ab, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const all = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" }) as string[][];

    let hIdx = 0;
    for (let i = 0; i < Math.min(5, all.length); i++) {
      const j = all[i].join("|").toLowerCase();
      if (j.includes("nr") && j.includes("kraj")) { hIdx = i; break; }
    }
    const headers = all[hIdx].map(h => String(h).trim());
    function get(row: string[], ...keys: string[]): string {
      for (const key of keys) {
        const idx = headers.findIndex(h => h.toLowerCase().includes(key.toLowerCase()));
        if (idx >= 0 && row[idx]) return String(row[idx]).trim();
      }
      return "";
    }

    // Build maps
    const vehMap: Record<string, Vehicle> = {};
    for (const v of vehicles) vehMap[v.reg] = v;

    // Trailer leasing map: naczepa_reg → leasing EUR/mo
    const trailerLeasingMap: Record<string, number> = {};
    for (const v of vehicles) {
      if (v.vehicle_type === "naczepa" && v.reg && v.leasing_eur_mo)
        trailerLeasingMap[v.reg] = Number(v.leasing_eur_mo);
    }
    const allTrailerLeasings = Object.values(trailerLeasingMap);
    const fleetAvgTrailerLeasing = allTrailerLeasings.length
      ? allTrailerLeasings.reduce((a, b) => a + b, 0) / allTrailerLeasings.length
      : undefined;

    const dispMap: Record<string, string> = {};
    for (const v of vehicles) {
      if (v.dispatcher_id) dispMap[v.reg] = v.dispatcher_id;
    }
    const dispNameMap: Record<string, string> = {};
    for (const d of dispatchers) dispNameMap[d.id] = d.name;

    // ── Pre-pass: buduj mapę ciągnik+data → łączna liczba km ──
    const dayGroupTotalKm = new Map<string, number>();
    for (const row of all.slice(hIdx + 1)) {
      const oNr = get(row, "Nr pełny", "Nr pe");
      if (!oNr) continue;
      // Pre-pass: używaj tych samych km co main-loop (ładowne wg licznika lub ładowne wg mapy)
      // WAŻNE: nie sumuj ładowne+puste tutaj — main-loop używa tylko ładownych jako distanceKm,
      // więc pre-pass i main-loop muszą zgadzać się na tej samej wartości żeby perDobeShareFactor=1.0
      // dla tras będących jedyną trasą ciągnika w danym dniu.
      const dKmLadOdo = parseFloat(get(row, "lad. wg licznika") || "0");
      const dKmMapLad = parseFloat(get(row, "km ład", "km wg", "Km") || "0");
      const dKm = dKmLadOdo > 0 ? dKmLadOdo : dKmMapLad;
      if (dKm < 10) continue;
      const veh = get(row, "ciągnik", "ciagnik", "pojazd").toUpperCase();
      // Pre-pass: używaj actual pickup date (tak samo jak main-loop) żeby perDobeShareFactor zgadzał się
      const pickupR = get(row, "podjęcie rzeczywiste", "podjecie rzeczywiste", "podjęcie", "podjecie", "data załadunku");
      const tDate = toDateKey(pickupR);
      if (veh && tDate) {
        const k = `${veh}|${tDate}`;
        dayGroupTotalKm.set(k, (dayGroupTotalKm.get(k) ?? 0) + dKm);
      }
    }

    const metrics: RouteMetric[] = [];

    for (const row of all.slice(hIdx + 1)) {
      const orderNr = get(row, "Nr pełny", "Nr pe");
      if (!orderNr) continue;

      // km wg licznika (odometr) — rzeczywiste km przejechane; fallback: km wg mapy
      const kmLadOdo   = parseFloat(get(row, "lad. wg licznika") || "0");
      const kmPusteOdo = parseFloat(get(row, "puste wg licznika") || "0");
      const kmLadMapa  = parseFloat(get(row, "km ład", "km wg", "Km") || "0");
      const kmPusteMapa = parseFloat(get(row, "puste km", "km puste", "km pusty", "km empty") || "0");

      // Preferuj licznik: distanceKm = ładowne wg licznika, emptyKm = puste wg licznika
      const distanceKm = kmLadOdo > 0 ? kmLadOdo : kmLadMapa;
      const emptyKm    = kmLadOdo > 0
        ? (kmPusteOdo > 0 ? kmPusteOdo : undefined)
        : (kmPusteMapa > 0 ? kmPusteMapa : undefined);
      if (distanceKm < 10) continue;

      const frachtRaw = get(row, "fracht z wal", "fracht");
      let frachtEur = parseFracht(frachtRaw, eurRate);
      // Niektóre trasy mają częściowy fracht (np. 800€) + dopłatę — "Stawka końcowa Xeuro" w Wymaganiach
      const wymagania = get(row, "wymagania");
      const stawkaMatch = wymagania.match(/stawka\s+ko[ńn]cowa\s+([\d\s,.]+)\s*[€eE]/i);
      if (stawkaMatch) {
        const finalRate = parseFloat(stawkaMatch[1].replace(/[\s]/g, "").replace(",", "."));
        if (!isNaN(finalRate) && finalRate > frachtEur) frachtEur = finalRate;
      }
      // NOTE: do NOT skip fracht=0 routes — estimate them like analiza does (see below)

      const vehicle    = get(row, "ciągnik", "ciagnik", "pojazd").toUpperCase();
      const naczepaReg = get(row, "naczepa", "naczepa:", "naczepa ").toUpperCase();
      const client     = get(row, "zleceniodawca", "klient", "nadawca") || "—";
      const originCountry = get(row, "zał. kraj", "zal. kraj", "kraj za").toUpperCase() || "PL";
      const destCountry   = get(row, "roz. kraj", "kraj ro").toUpperCase() || "PL";

      const vData = vehMap[vehicle];

      // Real toll: prefer EUR column, fallback to PLN→EUR (unified with analiza)
      const tmsTollEurRaw = parseFloat(get(row,
        "myto na trasie eur", "myto eur", "maut eur", "toll eur", "opłata drogowa eur"
      ) || "0");
      const tmsTollPlnRaw = parseFloat(get(row,
        "myto na trasie pln", "myto pln", "maut pln", "toll pln",
        "opłata drogowa pln", "opłata drogowa"
      ) || "0");
      const tmsTollEur = tmsTollEurRaw > 0
        ? tmsTollEurRaw
        : tmsTollPlnRaw > 0 ? Math.round((tmsTollPlnRaw / eurRate) * 100) / 100 : 0;

      // TMS own margin/km — used to estimate fracht when invoice missing
      const tmsMarzaPerKmRaw = parseFloat(get(row, "marża eur na 1 km", "marża eur") || "0");
      const tmsMarzaPerKm = isNaN(tmsMarzaPerKmRaw) ? 0 : tmsMarzaPerKmRaw;

      // Route dates — prefer "rzeczywiste" (actual) over planned
      // TMS columns: "Podjęcie rzeczywiste" / "Podjęcie" for pickup
      //              "Dostarczenie rzeczywiste" / "Dostarczenie" for delivery
      const pickupRaw   = get(row, "podjęcie rzeczywiste", "podjecie rzeczywiste", "podjęcie", "podjecie", "data załadunku");
      const deliveryRaw = get(row, "dostarczenie rzeczywiste", "dostarczenie", "data rozładunku", "data dostarczenia");
      const tripDate    = toDateKey(pickupRaw);
      const deliveryDate = toDateKey(deliveryRaw);

      // Driver name from TMS
      const driverName = get(row, "kierowca 1", "kierowca1", "kierowca", "driver").trim();

      // Route duration — ułamkowe dni na podstawie rzeczywistych timestamp-ów
      // (np. trasa 6h = 0.25d, trasa 31h = 1.29d); totalKm = ładowne + puste dla sanity check
      let routeDays: number | undefined;
      const pickupTs   = toTimestamp(pickupRaw);
      const deliveryTs = toTimestamp(deliveryRaw);
      const totalKm    = distanceKm + (emptyKm ?? 0);
      const maxReasonableDays = Math.max(2, Math.ceil((totalKm || 500) / 150));
      if (pickupTs !== undefined && deliveryTs !== undefined && deliveryTs > pickupTs) {
        const durationDays = (deliveryTs - pickupTs) / 86400000;
        routeDays = durationDays <= maxReasonableDays
          ? Math.round(durationDays * 100) / 100   // 2 miejsca dla kalkulacji, UI pokazuje 1
          : undefined;
      } else if (tripDate && deliveryDate && deliveryDate >= tripDate) {
        // Fallback: całkowite dni kalendarzowe gdy brak dokładnych timestamp-ów
        const rawDays = Math.max(1, daysBetween(tripDate, deliveryDate) + 1);
        routeDays = rawDays <= maxReasonableDays ? rawDays : undefined;
      }

      // Kontynuacja — ten sam ciągnik, ten sam dzień
      const dayKey = vehicle && tripDate ? `${vehicle}|${tripDate}` : "";
      const totalKmDay = dayKey ? (dayGroupTotalKm.get(dayKey) ?? distanceKm) : distanceKm;
      const perDobeShareFactor = totalKmDay > distanceKm
        ? Math.round((distanceKm / totalKmDay) * 10000) / 10000
        : 1.0;
      const isContinuation = perDobeShareFactor < 1.0;

      // Trailer leasing: (1) exact naczepa from TMS row, (2) fleet avg, (3) tier in calculator
      const trailerLeasingEurMo = (naczepaReg && trailerLeasingMap[naczepaReg])
        ? trailerLeasingMap[naczepaReg]
        : fleetAvgTrailerLeasing;

      const calcBase = {
        originCountry, destCountry, distanceKm, emptyKm,
        fuelPriceEurL: fuelPrice,
        transitCountries: [originCountry, destCountry],
        avgFuelL100: vData?.avg_fuel_l100 ?? FLEET.avgFuelL100,
        vehicleYearProduced: vData?.year_produced ?? undefined,
        leasingEurMo: vData?.leasing_eur_mo ?? undefined,
        trailerLeasingEurMo,
        insuranceEurMo: vData?.insurance_eur_mo ?? undefined,
        serviceCostKmOverride: vData?.service_cost_km ?? undefined,
        routeDays,
        overrideTollEur: tmsTollEur || undefined,
        perDobeShareFactor,
      };

      // Estimate fracht when TMS has no invoice yet (fracht=0), using TMS margin/km
      // Unified with analiza/page.tsx logic
      let frachtEstimated = false;
      let noFreightData = false;
      if (frachtEur === 0 && tmsMarzaPerKm > 0) {
        const bd0 = calculateRoute({ ...calcBase, freightEur: 1 }, settings);
        frachtEur = Math.round((bd0.total + tmsMarzaPerKm * distanceKm) * 100) / 100;
        frachtEstimated = true;
      } else if (frachtEur === 0) {
        // No invoice AND no TMS margin hint — include as "brak danych" (costs are real, revenue unknown)
        noFreightData = true;
      }

      // Always calculate costs — even when fracht=0 we want to show the cost exposure
      const bd = calculateRoute({ ...calcBase, freightEur: frachtEur }, settings);

      const disp_id = dispMap[vehicle] ?? null;
      metrics.push({
        orderNr, client, vehicle,
        dispatcher_id: disp_id,
        dispatcherName: disp_id ? (dispNameMap[disp_id] ?? "—") : "Nieprzypisany",
        originCountry, destCountry, distanceKm, emptyKm,
        totalKm: distanceKm + (emptyKm ?? 0),
        frachtEur, frachtEstimated, noFreightData,
        totalCost: bd.total, marginEur: bd.marginEur,
        marginPct: bd.marginPct, tollEur: bd.toll,
        label: noFreightData ? "BRAK DANYCH" : bd.marginPct >= 15 ? "Rentowna" : bd.marginPct >= 5 ? "Niska marża" : bd.marginPct >= 0 ? "Próg" : "STRATA",
        routeDays: bd.routeDays,
        breakdown: {
          fuel: bd.fuel, adblue: bd.adblue, idle: bd.idle,
          toll: bd.toll, driver: bd.driver, service: bd.service,
          leasing: bd.leasing, trailerLeasing: bd.trailerLeasing, insurance: bd.insurance,
        },
        costPerKm: bd.costPerKm,
        revenuePerKm: bd.revenuePerKm,
        isContinuation, perDobeShareFactor, tripDate,
        deliveryDate, driverName,
        tripTimestamp: pickupTs,
        deliveryTimestamp: deliveryTs,
      });
    }

    // Aggregate per dispatcher
    const grouped: Record<string, RouteMetric[]> = {};
    const UNASSIGNED = "__unassigned__";
    for (const m of metrics) {
      const key = m.dispatcher_id ?? UNASSIGNED;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(m);
    }

    const buildKpi = (d: {id: string; name: string}, routes: RouteMetric[], vehs: Vehicle[]) => {
      const frachtEur = routes.reduce((s, r) => s + r.frachtEur, 0);
      const costEur   = routes.reduce((s, r) => s + r.totalCost, 0);
      const marginEur = frachtEur - costEur;
      const marginPct = frachtEur > 0 ? (marginEur / frachtEur) * 100 : 0;
      return {
        id: d.id, name: d.name,
        vehicles: vehs.map(v => v.reg),
        ciagniki: vehs.filter(v => v.vehicle_type === "ciągnik").map(v => v.reg),
        naczepy:  vehs.filter(v => v.vehicle_type === "naczepa").map(v => v.reg),
        routes: routes.length, frachtEur, costEur, marginEur, marginPct,
        kmTotal: Math.round(routes.reduce((s, r) => s + r.totalKm, 0)),
        losses:    routes.filter(r => r.marginPct < 0).length,
        lowMargin: routes.filter(r => r.marginPct >= 0 && r.marginPct < 5).length,
        breakeven: routes.filter(r => r.marginPct >= 5 && r.marginPct < 15).length,
        profitable: routes.filter(r => r.marginPct >= 15).length,
        avgMarginPct: routes.length > 0 ? routes.reduce((s,r) => s+r.marginPct,0)/routes.length : 0,
        routeList: routes,
      };
    };

    const kpis: DispatcherKPI[] = dispatchers.map(d => {
      const vehs = vehicles.filter(v => v.dispatcher_id === d.id);
      return buildKpi(d, grouped[d.id] ?? [], vehs);
    });

    // Add unassigned
    const unassigned = grouped[UNASSIGNED] ?? [];
    if (unassigned.length > 0) {
      const fr = unassigned.reduce((s,r)=>s+r.frachtEur,0);
      const co = unassigned.reduce((s,r)=>s+r.totalCost,0);
      kpis.push({
        id: UNASSIGNED, name: "⚠ Nieprzypisane", vehicles: [], ciagniki: [], naczepy: [],
        routes: unassigned.length, frachtEur: fr, costEur: co,
        marginEur: fr-co, marginPct: fr > 0 ? (fr-co)/fr*100 : 0,
        kmTotal: Math.round(unassigned.reduce((s,r)=>s+r.totalKm,0)),
        losses: unassigned.filter(r=>r.marginPct<0).length,
        lowMargin: unassigned.filter(r=>r.marginPct>=0&&r.marginPct<5).length,
        breakeven: unassigned.filter(r=>r.marginPct>=5&&r.marginPct<15).length,
        profitable: unassigned.filter(r=>r.marginPct>=15).length,
        avgMarginPct: unassigned.length > 0 ? unassigned.reduce((s,r)=>s+r.marginPct,0)/unassigned.length : 0,
        routeList: unassigned,
      });
    }

    kpis.sort((a,b) => b.marginEur - a.marginEur);

    // ─── Monthly vehicle analysis ─────────────────────────────
    // Group all metrics by vehicle + month (by pickup date)
    const mvMap = new Map<string, RouteMetric[]>();
    for (const m of metrics) {
      if (!m.tripDate) continue;
      const mo = m.tripDate.slice(0, 7); // "YYYY-MM"
      const k  = `${m.vehicle}|${mo}`;
      if (!mvMap.has(k)) mvMap.set(k, []);
      mvMap.get(k)!.push(m);
    }

    const monthlySummaries: MonthlyVehicleSummary[] = [];
    for (const [key, routes] of mvMap.entries()) {
      const [vehicle, month] = key.split("|");
      // Sort routes by pickup date
      const sorted = [...routes].sort((a, b) => a.tripDate.localeCompare(b.tripDate));

      // Compute gaps between consecutive routes (ułamkowe godziny gdy timestampy dostępne)
      const gaps: RouteGap[] = [];
      for (let i = 0; i < sorted.length - 1; i++) {
        const prev = sorted[i];
        const next = sorted[i + 1];
        if (!prev.deliveryDate || !next.tripDate) continue;
        // Preferuj timestamp dla dokładnych ułamków doby; fallback: dni kalendarzowe
        const gap = (prev.deliveryTimestamp !== undefined && next.tripTimestamp !== undefined)
          ? (next.tripTimestamp - prev.deliveryTimestamp) / 86400000
          : daysBetween(prev.deliveryDate, next.tripDate);
        if (gap <= 0) continue; // overlapping or same-day: no idle

        // Daily fixed-cost rate: driver + leasing/30 + trailerLeasing/30 + insurance/30
        // Use the breakdown of any route for per-day rates (avg if multiple)
        const bd = prev.breakdown;
        const driverDailyRate = settings.driverDailyCost ?? 181.95;
        const days = prev.routeDays || 1;
        const leasingDailyRate = (bd.leasing + bd.trailerLeasing) / days;
        const insuranceDailyRate = bd.insurance / days;
        // Jeśli postój wypada między różnymi kierowcami — kierowca odszedł (lub nie dojechał),
        // więc nie naliczamy jego dobówki za dni przestoju pojazdu.
        const driverChanged = !!(prev.driverName && next.driverName && prev.driverName !== next.driverName);
        // Postój >2 dni w Polsce = serwis / pojazd w kraju — kierowca nie pobiera diety
        const isServicePl = gap > 2 && (prev.destCountry === "PL" || prev.destCountry === "pl");
        const effectiveDriverRate = (driverChanged || isServicePl) ? 0 : driverDailyRate;
        const dailyFixed = effectiveDriverRate + leasingDailyRate + insuranceDailyRate;

        gaps.push({
          prevRoute: prev,
          nextRoute: next,
          idleDays: gap,
          idleCostEur: Math.round(gap * dailyFixed * 100) / 100,
          isServicePl,
        });
      }

      // Unikalne dni kalendarzowe pokryte trasami (ceil routeDays — trasa 0.25d też zajmuje 1 dzień)
      const activeDaySet = new Set<string>();
      for (const r of sorted) {
        if (!r.tripDate) continue;
        const start = new Date(r.tripDate);
        const days  = Math.ceil(r.routeDays ?? 1);
        for (let d = 0; d < days; d++) {
          const dt = new Date(start);
          dt.setUTCDate(dt.getUTCDate() + d);
          activeDaySet.add(dt.toISOString().slice(0, 10));
        }
      }
      const activeDays = activeDaySet.size;
      const idleDays   = gaps.reduce((s, g) => s + g.idleDays, 0);
      const idleCost   = gaps.reduce((s, g) => s + g.idleCostEur, 0);
      const totalFreight = sorted.reduce((s, r) => s + r.frachtEur, 0);
      const totalRouteCosts = sorted.reduce((s, r) => s + r.totalCost, 0);
      const routeMarginSum = sorted.reduce((s, r) => s + r.marginEur, 0);
      const trueMargin = routeMarginSum - idleCost;
      const trueMarginPct = totalFreight > 0 ? (trueMargin / totalFreight) * 100 : 0;
      const drivers = [...new Set(sorted.map(r => r.driverName).filter(Boolean))];

      monthlySummaries.push({
        vehicle, month, routes: sorted, gaps,
        activeDays, idleDays, idleCostEur: Math.round(idleCost),
        totalFreight, totalRouteCosts,
        trueMonthlyMargin: Math.round(trueMargin),
        trueMarginPct,
        routeMarginSum: Math.round(routeMarginSum),
        drivers,
      });
    }
    // Sort: month desc, then by idle cost desc (biggest problem first)
    monthlySummaries.sort((a, b) =>
      b.month.localeCompare(a.month) || b.idleCostEur - a.idleCostEur
    );
    setMonthlyData(monthlySummaries);

    setKpiData(kpis);
    setActiveTab("dashboard");
    setAnalysisLoading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  // ─── Excel Export ─────────────────────────────────────────────
  function exportExcel() {
    const wb2 = XLSX.utils.book_new();

    // Summary sheet
    const summaryData = [
      ["RAPORT TYGODNIOWY HBM AUDYT — Wyniki Dyspozytorów"],
      [`Tydzień: ${weekLabel}`, "", "", `Kurs EUR/PLN: ${eurRate}`, `Paliwo: ${fuelPrice} EUR/l`],
      [],
      ["Dyspozytor", "Ciągniki", "Naczepy", "Trasy", "Fracht EUR", "Koszty HBM EUR", "Marża EUR", "Marża %",
       "Śr. marża %", "Km", "Straty", "Niska marża", "Rentowne"],
      ...kpiData.map(d => [
        d.name, d.ciagniki.length, d.naczepy.length, d.routes,
        Math.round(d.frachtEur), Math.round(d.costEur), Math.round(d.marginEur),
        +d.marginPct.toFixed(1), +d.avgMarginPct.toFixed(1), d.kmTotal,
        d.losses, d.lowMargin + d.breakeven, d.profitable,
      ]),
      [],
      ["SUMA FLOTY", "", kpiData.reduce((s,d)=>s+d.routes,0),
       Math.round(kpiData.reduce((s,d)=>s+d.frachtEur,0)),
       Math.round(kpiData.reduce((s,d)=>s+d.costEur,0)),
       Math.round(kpiData.reduce((s,d)=>s+d.marginEur,0)),
      ],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
    ws1["!cols"] = [16,8,8,6,12,14,12,8,10,8,7,10,10].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb2, ws1, "Podsumowanie");

    // Klienci ranking — wszystkie trasy
    const allR = kpiData.flatMap(d => d.routeList);
    const clientMap: Record<string, {routes:number;fracht:number;margin:number;losses:number;disp:Set<string>}> = {};
    for (const r of allR) {
      if (!clientMap[r.client]) clientMap[r.client] = {routes:0,fracht:0,margin:0,losses:0,disp:new Set()};
      clientMap[r.client].routes++;
      clientMap[r.client].fracht += r.frachtEur;
      clientMap[r.client].margin += r.marginEur;
      if (r.marginPct < 0) clientMap[r.client].losses++;
      clientMap[r.client].disp.add(r.dispatcherName);
    }
    const clientRows = Object.entries(clientMap)
      .map(([name, s]) => [name, s.routes, Math.round(s.fracht), Math.round(s.margin),
        +(s.fracht>0?(s.margin/s.fracht*100):0).toFixed(1), s.losses, [...s.disp].join(", ")])
      .sort((a,b) => (a[4] as number)-(b[4] as number));
    const wsC = XLSX.utils.aoa_to_sheet([
      [`Zleceniodawcy — ${weekLabel}`], [],
      ["Zleceniodawca","Trasy","Fracht EUR","Marża EUR","Marża %","Straty","Dyspozytorzy"],
      ...clientRows,
    ]);
    wsC["!cols"] = [30,6,12,12,8,7,25].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb2, wsC, "Zleceniodawcy");

    // Per-dispatcher sheets
    for (const d of kpiData) {
      if (d.routeList.length === 0) continue;
      const rows = [
        [`${d.name} — Trasy tygodnia ${weekLabel}`],
        [`Razem: ${d.routes} tras | Fracht: ${Math.round(d.frachtEur)} EUR | Marża: ${Math.round(d.marginEur)} EUR (${d.marginPct.toFixed(1)}%)`],
        [],
        ["Nr zlecenia", "Zleceniodawca", "Pojazd", "Trasa", "Km", "Dni", "Fracht EUR", "Koszty HBM", "Marża EUR", "Marża %", "Status"],
        ...d.routeList.map(r => [
          r.orderNr, r.client, r.vehicle,
          `${r.originCountry} → ${r.destCountry}`,
          Math.round(r.totalKm), r.routeDays,
          Math.round(r.frachtEur), Math.round(r.totalCost), Math.round(r.marginEur),
          +r.marginPct.toFixed(1), r.label,
        ]),
      ];
      const wsD = XLSX.utils.aoa_to_sheet(rows);
      wsD["!cols"] = [16,10,12,7,10,12,10,8,12].map(w => ({ wch: w }));
      const sheetName = d.name.replace(/[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ ]/g, "").slice(0, 31);
      XLSX.utils.book_append_sheet(wb2, wsD, sheetName);
    }

    XLSX.writeFile(wb2, `Raport_Dyspozytorzy_${weekLabel.replace(/[^0-9\-]/g,"_")}.xlsx`);
  }

  const dispById = Object.fromEntries(dispatchers.map(d => [d.id, d]));
  const selectedKpi = kpiData.find(d => d.id === selectedDispatcher);
  const allRoutes = kpiData.flatMap(d => d.routeList);

  // Rentowność klientów — te same trasy/koszty co w Trasach i Dashboardzie,
  // przegrupowane po Zleceniodawcy zamiast po dyspozytorze.
  const clientRows = (() => {
    const byVehicleType = vehicleTypeFilter === "all" ? allRoutes : allRoutes.filter(r => {
      const vType = vehicles.find(v => v.reg === r.vehicle)?.vehicle_type;
      return vType === vehicleTypeFilter;
    });
    const map = new Map<string, RouteMetric[]>();
    for (const r of byVehicleType) {
      if (!map.has(r.client)) map.set(r.client, []);
      map.get(r.client)!.push(r);
    }
    const rows = Array.from(map.entries()).map(([name, routes]) => {
      const fracht = routes.reduce((s, r) => s + r.frachtEur, 0);
      const cost = routes.reduce((s, r) => s + r.totalCost, 0);
      const margin = fracht - cost;
      const marginPct = fracht > 0 ? (margin / fracht) * 100 : 0;
      const km = routes.reduce((s, r) => s + r.totalKm, 0);
      const rated = routes.filter(r => !r.noFreightData);
      return {
        name, routes: routes.length, km, fracht, cost, margin, marginPct,
        losses: rated.filter(r => r.marginPct < 0).length,
        lowMargin: rated.filter(r => r.marginPct >= 0 && r.marginPct < 5).length,
        breakeven: rated.filter(r => r.marginPct >= 5 && r.marginPct < 15).length,
        profitable: rated.filter(r => r.marginPct >= 15).length,
        noData: routes.length - rated.length,
      };
    });
    const q = clientSearch.trim().toLowerCase();
    const filtered = q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows;
    filtered.sort((a, b) => {
      const av = a[clientSortKey], bv = b[clientSortKey];
      const cmp = typeof av === "string" ? av.localeCompare(bv as string, "pl") : (av as number) - (bv as number);
      return clientSortDesc ? -cmp : cmp;
    });
    return filtered;
  })();
  function toggleClientSort(key: typeof clientSortKey) {
    if (clientSortKey === key) setClientSortDesc(d => !d);
    else { setClientSortKey(key); setClientSortDesc(key === "name" ? false : true); }
  }
  const ClientSortIcon = ({ k }: { k: typeof clientSortKey }) =>
    clientSortKey === k ? <span className="ml-1 text-blue-500">{clientSortDesc ? "↓" : "↑"}</span> : <span className="ml-1 text-slate-300">↕</span>;

  if (loading) return (
    <div className="flex items-center gap-2 text-blue-600 text-sm p-8">
      <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      Ładowanie…
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dyspozytorzy — Rozliczenia tygodniowe</h1>
          <p className="text-slate-500 text-sm mt-1">{dispatchers.length} dyspozytorów · {vehicles.filter(v=>v.dispatcher_id).length}/{vehicles.length} pojazdów przypisanych</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>EUR/PLN:</span>
            <input type="number" value={eurRate} step="0.01" onChange={e=>setEurRate(+e.target.value)}
              className="w-16 px-2 py-1 border border-slate-200 rounded text-sm" />
            <span>Paliwo:</span>
            <input type="number" value={fuelPrice} step="0.01" onChange={e=>setFuelPrice(+e.target.value)}
              className="w-16 px-2 py-1 border border-slate-200 rounded text-sm" />
          </div>
          <label className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-colors
            ${analysisLoading ? "bg-slate-200 text-slate-500" : "bg-blue-600 text-white hover:bg-blue-700"}`}>
            <span>⬆ Wczytaj TMS (tydzień)</span>
            <input ref={fileRef} type="file" accept=".xls,.xlsx" className="hidden" onChange={handleTmsUpload} disabled={analysisLoading} />
          </label>
          {kpiData.length > 0 && (
            <button onClick={exportExcel}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 transition-colors">
              ⬇ Excel
            </button>
          )}
        </div>
      </div>

      {/* Week label */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-500">Tydzień:</span>
        <input value={weekLabel} onChange={e=>setWeekLabel(e.target.value)}
          className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none w-64" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {([["dashboard","📊 Dashboard"], ["routes","📋 Trasy"], ["clients","🧑‍💼 Klienci"], ["idle","⏸ Przestoje"], ["monthly","📅 Bilans miesięczny"], ["config","⚙ Konfiguracja"]] as [string,string][]).map(([t,l]) => (
          <button key={t} onClick={()=>setActiveTab(t as any)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
              activeTab===t ? "border-blue-600 text-blue-600 bg-blue-50" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {l}
          </button>
        ))}
      </div>

      {/* ── Dashboard ── */}
      {activeTab === "dashboard" && (
        <div className="space-y-4">
          {/* Vehicle type filter */}
          {kpiData.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Filtruj trasy wg pojazdu:</span>
              {(["all","ciągnik","naczepa"] as const).map(t => (
                <button key={t} onClick={() => setVehicleTypeFilter(t)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                    vehicleTypeFilter === t
                      ? t === "ciągnik" ? "bg-blue-600 text-white"
                        : t === "naczepa" ? "bg-slate-600 text-white"
                        : "bg-slate-800 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  {t === "all" ? "🚛+🚌 Wszystkie" : t === "ciągnik" ? "🚛 Ciągniki" : "🚌 Naczepy"}
                </button>
              ))}
            </div>
          )}
          {kpiData.length === 0 ? (
            <div className="card py-16 text-center text-slate-400">
              <p className="text-lg mb-2">Brak danych</p>
              <p className="text-sm">Wczytaj plik TMS żeby zobaczyć wyniki dyspozytorów</p>
            </div>
          ) : (
<>
              {/* Fleet totals */}
              {(() => {
                const totalFracht = kpiData.reduce((s,d)=>s+d.frachtEur,0);
                const totalCost   = kpiData.reduce((s,d)=>s+d.costEur,0);
                const totalMargin = kpiData.reduce((s,d)=>s+d.marginEur,0);
                const totalIdle   = monthlyData.reduce((s,x)=>s+x.idleCostEur,0);
                const trueMargin  = totalMargin - totalIdle;
                const truePct     = totalFracht > 0 ? trueMargin / totalFracht : 0;
                const avgMargin   = kpiData.filter(d=>d.id!=="__unassigned__"&&d.routes>0).reduce((s,d)=>s+d.marginPct,0)/Math.max(1,kpiData.filter(d=>d.id!=="__unassigned__"&&d.routes>0).length);
                return (
                  <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
                    {[
                      ["Łączny fracht",    fmtEur(totalFracht),  "text-slate-800",   ""],
                      ["Łączne koszty HBM",fmtEur(totalCost),    "text-slate-800",   ""],
                      ["Marża tras",       fmtEur(totalMargin),  totalMargin>=0?"text-emerald-600":"text-red-600", fmtPct(totalFracht>0?totalMargin/totalFracht:0)],
                      ["Koszty postojów",  totalIdle>0?`−${fmtEur(totalIdle)}`:"brak danych", totalIdle>0?"text-amber-600":"text-slate-400",
                        totalIdle>0&&totalFracht>0?`${(totalIdle/totalFracht*100).toFixed(1)}% frachtu`:""],
                      ["Marża po postojach",fmtEur(trueMargin),  trueMargin>=0?(truePct>=0.05?"text-emerald-600":"text-amber-600"):"text-red-600", fmtPct(truePct)],
                      ["Śr. marża/dyspo",  fmtPct(avgMargin),    "text-slate-800",   ""],
                      ["Trasy ze stratą",  kpiData.reduce((s,d)=>s+d.losses,0).toString(), kpiData.reduce((s,d)=>s+d.losses,0)>0?"text-red-600":"text-emerald-600",""],
                    ].map(([label,val,cls,sub])=>(
                      <div key={label as string} className="card py-3">
                        <p className="text-xs text-slate-500 uppercase tracking-wide leading-tight">{label}</p>
                        <p className={`text-lg font-bold mt-0.5 ${cls}`}>{val}</p>
                        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Per dispatcher cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {kpiData.filter(d=>d.id!=="__unassigned__").map(d => {
                  // Apply vehicle type filter to route list for this card
                  const filteredRoutes = vehicleTypeFilter === "all" ? d.routeList
                    : d.routeList.filter(r => {
                        const vType = vehicles.find(v=>v.reg===r.vehicle)?.vehicle_type;
                        return vehicleTypeFilter === "ciągnik" ? vType === "ciągnik" : vType === "naczepa";
                      });
                  const filtFracht = filteredRoutes.reduce((s,r)=>s+r.frachtEur,0);
                  const filtCost   = filteredRoutes.reduce((s,r)=>s+r.totalCost,0);
                  const filtMargin = filtFracht - filtCost;
                  const filtMarginPct = filtFracht > 0 ? (filtMargin/filtFracht)*100 : 0;
                  return (
                  <div key={d.id}
                    onClick={()=>setSelectedDispatcher(selectedDispatcher===d.id?null:d.id)}
                    className={`card cursor-pointer transition-all ${selectedDispatcher===d.id?"ring-2 ring-blue-500 shadow-md":""} ${filteredRoutes.some(r=>r.marginPct<0)?"border-l-4 border-red-400":filtMarginPct>=15?"border-l-4 border-emerald-400":"border-l-4 border-amber-400"}`}>
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-bold text-slate-800">{d.name}</h3>
                        {/* CIĄ / NAC badges */}
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {d.ciagniki.length > 0 && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${vehicleTypeFilter==="ciągnik"?"bg-blue-600 text-white":"bg-blue-100 text-blue-700"}`}>
                              🚛 {d.ciagniki.length} CIĄ
                            </span>
                          )}
                          {d.naczepy.length > 0 && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${vehicleTypeFilter==="naczepa"?"bg-slate-600 text-white":"bg-slate-100 text-slate-600"}`}>
                              🚌 {d.naczepy.length} NAC
                            </span>
                          )}
                          <span className="text-[10px] text-slate-400">{filteredRoutes.length} tras · {Math.round(filteredRoutes.reduce((s,r)=>s+r.totalKm,0)).toLocaleString("pl-PL")} km</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`text-2xl font-black ${marginColor(filtMarginPct)}`}>{fmtPct(filtMarginPct)}</div>
                        <div className="text-xs text-slate-400">marża</div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div className="bg-slate-50 rounded-lg py-2">
                        <div className="text-sm font-bold text-slate-800">{fmtEur(filtFracht)}</div>
                        <div className="text-xs text-slate-400">fracht</div>
                      </div>
                      <div className="bg-slate-50 rounded-lg py-2">
                        <div className={`text-sm font-bold ${marginColor(filtMarginPct)}`}>{fmtEur(filtMargin)}</div>
                        <div className="text-xs text-slate-400">marża EUR</div>
                      </div>
                      <div className="bg-slate-50 rounded-lg py-2">
                        <div className="text-sm font-bold text-slate-800">
                          {filteredRoutes.length>0 ? fmtPct(filteredRoutes.reduce((s,r)=>s+r.marginPct,0)/filteredRoutes.length) : "—"}
                        </div>
                        <div className="text-xs text-slate-400">śr./trasę</div>
                      </div>
                    </div>

                    {/* Mini bar */}
                    <div className="mt-3 flex gap-1 text-xs flex-wrap">
                      {filteredRoutes.filter(r=>r.marginPct>=15&&!r.noFreightData).length>0 && <div className="bg-emerald-500 text-white rounded px-1.5 py-0.5">✓ {filteredRoutes.filter(r=>r.marginPct>=15&&!r.noFreightData).length}</div>}
                      {filteredRoutes.filter(r=>r.marginPct>=5&&r.marginPct<15&&!r.noFreightData).length>0 && <div className="bg-amber-400 text-white rounded px-1.5 py-0.5">~ {filteredRoutes.filter(r=>r.marginPct>=5&&r.marginPct<15&&!r.noFreightData).length}</div>}
                      {filteredRoutes.filter(r=>r.marginPct>=0&&r.marginPct<5&&!r.noFreightData).length>0 && <div className="bg-orange-400 text-white rounded px-1.5 py-0.5">↓ {filteredRoutes.filter(r=>r.marginPct>=0&&r.marginPct<5&&!r.noFreightData).length}</div>}
                      {filteredRoutes.filter(r=>r.marginPct<0&&!r.noFreightData).length>0 && <div className="bg-red-600 text-white rounded px-1.5 py-0.5 font-bold">✗ {filteredRoutes.filter(r=>r.marginPct<0&&!r.noFreightData).length} STRAT</div>}
                      {filteredRoutes.filter(r=>r.noFreightData).length>0 && <div className="bg-slate-300 text-slate-700 rounded px-1.5 py-0.5">? {filteredRoutes.filter(r=>r.noFreightData).length} BD</div>}
                      {filteredRoutes.length===0 && <div className="text-slate-400 italic">brak tras w tym tygodniu</div>}
                    </div>
                  </div>
                  );
                })}
              </div>

              {/* Unassigned warning */}
              {kpiData.find(d=>d.id==="__unassigned__") && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-3">
                  <span className="text-amber-600 text-xl">⚠</span>
                  <div>
                    <p className="font-semibold text-amber-800">
                      {kpiData.find(d=>d.id==="__unassigned__")!.routes} tras bez przypisanego dyspozytora
                    </p>
                    <p className="text-sm text-amber-700">Przypisz pojazdy do dyspozytorów w zakładce Konfiguracja</p>
                  </div>
                </div>
              )}

              {/* Drill-down — selected dispatcher */}
              {selectedKpi && (() => {
                // Ranking klientów per dyspozytor
                const clientStats: Record<string, {routes:number;margin:number;losses:number;fracht:number}> = {};
                for (const r of selectedKpi.routeList) {
                  if (!clientStats[r.client]) clientStats[r.client] = {routes:0,margin:0,losses:0,fracht:0};
                  clientStats[r.client].routes++;
                  clientStats[r.client].margin += r.marginEur;
                  clientStats[r.client].fracht += r.frachtEur;
                  if (r.marginPct < 0) clientStats[r.client].losses++;
                }
                const clientRank = Object.entries(clientStats)
                  .map(([name, s]) => ({name, ...s, marginPct: s.fracht>0?(s.margin/s.fracht)*100:0}))
                  .sort((a,b) => a.marginPct - b.marginPct);

                return (
                <div className="space-y-3">
                  {/* Client ranking */}
                  {clientRank.length > 1 && (
                    <div className="card p-0 overflow-hidden">
                      <div className="px-4 py-2.5 bg-slate-50 border-b">
                        <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wide">Zleceniodawcy — {selectedKpi.name}</h4>
                      </div>
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 border-b border-slate-100">
                          <tr>
                            <th className="text-left px-4 py-2 text-xs font-semibold text-slate-400 uppercase">Zleceniodawca</th>
                            <th className="text-right px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Trasy</th>
                            <th className="text-right px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Fracht</th>
                            <th className="text-right px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Marża EUR</th>
                            <th className="text-right px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Marża %</th>
                            <th className="text-center px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Straty</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {clientRank.map(c => (
                            <tr key={c.name} className={`hover:bg-slate-50 ${c.losses>0?"bg-red-50/40":c.marginPct>=15?"":"bg-amber-50/20"}`}>
                              <td className="px-4 py-2 text-xs font-medium text-slate-800 max-w-[200px] truncate">{c.name}</td>
                              <td className="px-3 py-2 text-right text-xs text-slate-600">{c.routes}</td>
                              <td className="px-3 py-2 text-right text-xs">{Math.round(c.fracht).toLocaleString("pl-PL")} €</td>
                              <td className={`px-3 py-2 text-right text-xs font-semibold ${marginColor(c.marginPct)}`}>{Math.round(c.margin).toLocaleString("pl-PL")} €</td>
                              <td className={`px-3 py-2 text-right text-xs font-bold ${marginColor(c.marginPct)}`}>{fmtPct(c.marginPct)}</td>
                              <td className="px-3 py-2 text-center">
                                {c.losses > 0
                                  ? <span className="text-xs bg-red-100 text-red-700 font-bold px-2 py-0.5 rounded-full">{c.losses} ✗</span>
                                  : <span className="text-xs text-emerald-500">✓</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Route list */}
                  <div className="card p-0 overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 border-b flex items-center justify-between">
                    <h3 className="font-bold text-slate-800">Trasy — {selectedKpi.name}</h3>
                    <button onClick={()=>setSelectedDispatcher(null)} className="text-slate-400 hover:text-slate-700">✕</button>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Zlecenie</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Zleceniodawca</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Pojazd</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Trasa</th>
                        <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500 uppercase">km(L+P)/d</th>
                        <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Fracht</th>
                        <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Koszty</th>
                        <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Marża</th>
                        <th className="text-center px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedKpi.routeList.sort((a,b)=>a.marginPct-b.marginPct).map(r => (
                        <tr key={r.orderNr}
                          onClick={() => setAnalysisRoute(r)}
                          className={`cursor-pointer hover:bg-blue-50/30 ${r.noFreightData?"bg-slate-50/60":r.marginPct<0?"bg-red-50/30":""}`}>
                          <td className="px-4 py-2 font-mono text-xs text-slate-600">{r.orderNr}</td>
                          <td className="px-4 py-2 text-xs text-slate-700 max-w-[140px] truncate" title={r.client}>{r.client}</td>
                          <td className="px-4 py-2 font-mono text-xs font-semibold">{r.vehicle}</td>
                          <td className="px-4 py-2 text-xs text-slate-600">{r.originCountry}→{r.destCountry}</td>
                          <td className="px-4 py-2 text-right text-xs text-slate-500">
                            {Math.round(r.totalKm).toLocaleString("pl-PL")}<span className="text-slate-400">/{r.routeDays?.toFixed(1)}d</span>
                          </td>
                          <td className="px-4 py-2 text-right text-xs font-medium">
                            {r.noFreightData ? <span className="text-slate-400 italic">brak fraktury</span> : Math.round(r.frachtEur).toLocaleString("pl-PL")}
                            {r.frachtEstimated && <div className="text-amber-500 text-[10px] font-normal">~szacowany</div>}
                          </td>
                          <td className="px-4 py-2 text-right text-xs">{Math.round(r.totalCost).toLocaleString("pl-PL")}</td>
                          <td className={`px-4 py-2 text-right text-xs font-bold ${r.noFreightData?"text-slate-400":marginColor(r.marginPct)}`}>
                            {r.noFreightData ? "—" : fmtPct(r.marginPct)}
                          </td>
                          <td className="px-4 py-2 text-center">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              r.noFreightData?"bg-slate-100 text-slate-500":
                              r.marginPct>=15?"bg-emerald-100 text-emerald-700":
                              r.marginPct>=5?"bg-amber-100 text-amber-700":
                              r.marginPct>=0?"bg-orange-100 text-orange-700":
                              "bg-red-100 text-red-700 font-bold"}`}>
                              {r.label}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* ── All Routes ── */}
      {activeTab === "routes" && (
        <div className="space-y-3">
          {/* Route filters */}
          <div className="flex gap-2 flex-wrap items-center">
            <input value={routeSearch} onChange={e=>setRouteSearch(e.target.value)}
              placeholder="Szukaj zlecenia, pojazdu, trasy…"
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none w-64" />
            {(["all","ciągnik","naczepa"] as const).map(t => (
              <button key={t} onClick={() => setVehicleTypeFilter(t)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                  vehicleTypeFilter === t ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {t === "all" ? "Wszystkie" : t === "ciągnik" ? "🚛 Ciągniki" : "🚌 Naczepy"}
              </button>
            ))}
          </div>
        <div className="card overflow-x-auto p-0">
          {allRoutes.length === 0 ? (
            <div className="py-16 text-center text-slate-400 text-sm">Wczytaj plik TMS</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Zlecenie</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Zleceniodawca</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Dyspozytor</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Pojazd</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Trasa</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Fracht</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Marża</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {allRoutes
                  .filter(r => {
                    const vType = vehicles.find(v=>v.reg===r.vehicle)?.vehicle_type;
                    const typeOk = vehicleTypeFilter === "all" || vType === vehicleTypeFilter;
                    const q = routeSearch.toLowerCase();
                    const searchOk = !q || r.orderNr.toLowerCase().includes(q) ||
                      r.vehicle.toLowerCase().includes(q) || r.dispatcherName.toLowerCase().includes(q) ||
                      r.client.toLowerCase().includes(q) ||
                      r.originCountry.toLowerCase().includes(q) || r.destCountry.toLowerCase().includes(q);
                    return typeOk && searchOk;
                  })
                  .sort((a,b)=>a.marginPct-b.marginPct)
                  .map(r => {
                    const vType = vehicles.find(v=>v.reg===r.vehicle)?.vehicle_type;
                    return (
                    <tr key={r.orderNr} className={`hover:bg-slate-50 ${r.noFreightData?"bg-slate-50/60":r.marginPct<0?"bg-red-50/40":""}`}>
                      <td className="px-4 py-2 font-mono text-xs text-slate-600">{r.orderNr}</td>
                      <td className="px-4 py-2 text-xs text-slate-700 max-w-[150px] truncate" title={r.client}>{r.client}</td>
                      <td className="px-4 py-2 text-xs font-medium text-slate-700">{r.dispatcherName}</td>
                      <td className="px-4 py-2">
                        <span className="font-mono text-xs font-semibold">{r.vehicle}</span>
                        <span className={`ml-1.5 text-[10px] px-1 py-0 rounded font-bold ${vType==="ciągnik"?"bg-blue-100 text-blue-700":"bg-slate-100 text-slate-600"}`}>
                          {vType==="ciągnik"?"CIĄ":"NAC"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs">{r.originCountry}→{r.destCountry}</td>
                      <td className="px-4 py-2 text-right text-xs">
                        {r.noFreightData ? <span className="text-slate-400 italic">brak faktury</span> : <>{Math.round(r.frachtEur).toLocaleString("pl-PL")} €</>}
                      </td>
                      <td className={`px-4 py-2 text-right text-xs font-bold ${r.noFreightData?"text-slate-400":marginColor(r.marginPct)}`}>
                        {r.noFreightData ? "—" : fmtPct(r.marginPct)}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          r.noFreightData?"bg-slate-100 text-slate-500":
                          r.marginPct>=15?"bg-emerald-100 text-emerald-700":r.marginPct>=5?"bg-amber-100 text-amber-700":
                          r.marginPct>=0?"bg-orange-100 text-orange-700":"bg-red-100 text-red-700 font-bold"}`}>
                          {r.label}
                        </span>
                      </td>
                    </tr>
                  );})}
              </tbody>
            </table>
          )}
        </div>
        </div>
      )}

      {/* ── Rentowność klientów ── */}
      {activeTab === "clients" && (
        <div className="space-y-3">
          <div className="flex gap-2 flex-wrap items-center">
            <input value={clientSearch} onChange={e => setClientSearch(e.target.value)}
              placeholder="Szukaj klienta…"
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none w-64" />
            {(["all", "ciągnik", "naczepa"] as const).map(t => (
              <button key={t} onClick={() => setVehicleTypeFilter(t)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                  vehicleTypeFilter === t ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {t === "all" ? "Wszystkie" : t === "ciągnik" ? "🚛 Ciągniki" : "🚌 Naczepy"}
              </button>
            ))}
            {clientRows.length > 0 && (
              <span className="text-xs text-slate-400 ml-auto">{clientRows.length} klientów</span>
            )}
          </div>

          {allRoutes.length === 0 ? (
            <div className="card py-16 text-center text-slate-400">
              <p className="text-lg mb-2">Brak danych</p>
              <p className="text-sm">Wczytaj plik TMS żeby zobaczyć rentowność klientów</p>
            </div>
          ) : (
            <>
              {/* Podsumowanie */}
              {(() => {
                const totalFracht = clientRows.reduce((s, c) => s + c.fracht, 0);
                const totalCost = clientRows.reduce((s, c) => s + c.cost, 0);
                const totalMargin = totalFracht - totalCost;
                const lossClients = clientRows.filter(c => c.margin < 0).length;
                return (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="card py-3">
                      <p className="text-xs text-slate-500 uppercase tracking-wide">Klientów</p>
                      <p className="text-lg font-bold mt-0.5 text-slate-800">{clientRows.length}</p>
                    </div>
                    <div className="card py-3">
                      <p className="text-xs text-slate-500 uppercase tracking-wide">Łączny fracht</p>
                      <p className="text-lg font-bold mt-0.5 text-slate-800">{fmtEur(totalFracht)}</p>
                    </div>
                    <div className="card py-3">
                      <p className="text-xs text-slate-500 uppercase tracking-wide">Marża razem</p>
                      <p className={`text-lg font-bold mt-0.5 ${totalMargin >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {fmtEur(totalMargin)} <span className="text-sm font-normal">({fmtPct(totalFracht > 0 ? totalMargin / totalFracht * 100 : 0)})</span>
                      </p>
                    </div>
                    <div className={`card py-3 ${lossClients > 0 ? "border-l-4 border-red-400" : ""}`}>
                      <p className="text-xs text-slate-500 uppercase tracking-wide">Klienci na stracie</p>
                      <p className={`text-lg font-bold mt-0.5 ${lossClients > 0 ? "text-red-600" : "text-emerald-600"}`}>{lossClients}</p>
                    </div>
                  </div>
                );
              })()}

              <div className="card overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase w-12">LP</th>
                      {([
                        ["name", "Zleceniodawca", "text-left"],
                        ["routes", "Zleceń", "text-right"],
                        ["km", "Km", "text-right"],
                        ["fracht", "Fracht", "text-right"],
                        ["cost", "Koszty HBM", "text-right"],
                        ["margin", "Marża EUR", "text-right"],
                        ["marginPct", "Marża %", "text-right"],
                      ] as [typeof clientSortKey, string, string][]).map(([key, label, align]) => (
                        <th key={key} onClick={() => toggleClientSort(key)}
                          className={`${align} px-4 py-3 text-xs font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-800 select-none`}>
                          {label}<ClientSortIcon k={key} />
                        </th>
                      ))}
                      <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Rozkład tras</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {clientRows.length === 0 ? (
                      <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400 text-sm">Brak klientów spełniających kryteria</td></tr>
                    ) : clientRows.map((c, i) => (
                      <tr key={c.name} className={`hover:bg-slate-50 ${c.margin < 0 ? "bg-red-50/40" : ""}`}>
                        <td className="px-4 py-3 text-center text-slate-400 text-xs font-mono">{i + 1}</td>
                        <td className="px-4 py-3 text-slate-800 font-medium max-w-[220px] truncate" title={c.name}>{c.name}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{c.routes}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{Math.round(c.km).toLocaleString("pl-PL")}</td>
                        <td className="px-4 py-3 text-right text-slate-700">{fmtEur(c.fracht)}</td>
                        <td className="px-4 py-3 text-right text-slate-500">{fmtEur(c.cost)}</td>
                        <td className={`px-4 py-3 text-right font-semibold ${marginColor(c.marginPct)}`}>{fmtEur(c.margin)}</td>
                        <td className={`px-4 py-3 text-right font-bold ${marginColor(c.marginPct)}`}>{fmtPct(c.marginPct)}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 justify-center flex-wrap text-[10px]">
                            {c.profitable > 0 && <span className="bg-emerald-500 text-white rounded px-1.5 py-0.5">✓ {c.profitable}</span>}
                            {c.breakeven > 0 && <span className="bg-amber-400 text-white rounded px-1.5 py-0.5">~ {c.breakeven}</span>}
                            {c.lowMargin > 0 && <span className="bg-orange-400 text-white rounded px-1.5 py-0.5">↓ {c.lowMargin}</span>}
                            {c.losses > 0 && <span className="bg-red-600 text-white rounded px-1.5 py-0.5 font-bold">✗ {c.losses}</span>}
                            {c.noData > 0 && <span className="bg-slate-300 text-slate-700 rounded px-1.5 py-0.5">? {c.noData}</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Bilans miesięczny ── */}
      {activeTab === "monthly" && (
        <div className="space-y-4">
          {monthlyData.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <div className="text-4xl mb-3">📅</div>
              <p className="text-sm">Wczytaj plik XLS z kolumnami <b>Dostarczenie</b> i <b>Kierowca 1</b> aby zobaczyć bilans miesięczny</p>
            </div>
          ) : (
            <>
              {/* Summary banner */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                <b>Bilans miesięczny</b> pokazuje realne koszty pojazdów — łącznie z dniami postoju między zleceniami.
                Marża tras to wynik widoczny w tabeli Trasy. <b>Realna marża</b> odejmuje koszty dni bez zleceń (kierowca + leasing + ubezpieczenie).
              </div>

              {/* Month selector */}
              {(() => {
                const months = [...new Set(monthlyData.map(s => s.month))].sort().reverse();
                return months.map(mo => {
                  const monthSummaries = monthlyData.filter(s => s.month === mo);
                  const moLabel = new Date(mo + "-01").toLocaleString("pl-PL", { month: "long", year: "numeric" });
                  const totalIdle = monthSummaries.reduce((s,x)=>s+x.idleCostEur, 0);
                  const totalFr   = monthSummaries.reduce((s,x)=>s+x.totalFreight, 0);
                  const totalTrue = monthSummaries.reduce((s,x)=>s+x.trueMonthlyMargin, 0);

                  return (
                    <div key={mo} className="space-y-3">
                      {/* Month header */}
                      <div className="flex items-center justify-between bg-slate-800 text-white px-5 py-3 rounded-xl">
                        <span className="font-semibold capitalize">{moLabel}</span>
                        <div className="flex gap-6 text-sm">
                          <span>Postoje: <b className="text-amber-300">{fmtEur(totalIdle)}</b></span>
                          <span>Fracht: <b>{fmtEur(totalFr)}</b></span>
                          <span>Realna marża: <b className={totalTrue >= 0 ? "text-emerald-300" : "text-red-300"}>{fmtEur(totalTrue)}</b></span>
                        </div>
                      </div>

                      {/* Per-vehicle cards */}
                      {monthSummaries.map(s => {
                        const totalDays = s.activeDays + s.idleDays;
                        const utilizationPct = totalDays > 0 ? Math.round((s.activeDays / totalDays) * 100) : 0;
                        const trueMarginColor = s.trueMonthlyMargin >= 0
                          ? (s.trueMonthlyMargin / (s.totalFreight||1) * 100 >= 10 ? "text-emerald-600" : "text-amber-600")
                          : "text-red-600";

                        return (
                          <div key={s.vehicle} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                            {/* Card header */}
                            <div className="flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-200">
                              <div className="flex items-center gap-3">
                                <span className="font-bold text-slate-800 text-sm">{s.vehicle}</span>
                                {s.drivers.length > 0 && (
                                  <div className="flex gap-1 flex-wrap">
                                    {s.drivers.map(d => (
                                      <span key={d} className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{d}</span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-4 text-xs text-slate-500">
                                <span>{s.routes.length} {s.routes.length === 1 ? "trasa" : "trasy"}</span>
                                <span className={`font-semibold ${utilizationPct >= 70 ? "text-emerald-600" : utilizationPct >= 40 ? "text-amber-600" : "text-red-600"}`}>
                                  Utylizacja: {utilizationPct}%
                                </span>
                              </div>
                            </div>

                            {/* Timeline */}
                            <div className="px-5 py-3 overflow-x-auto">
                              <div className="flex items-stretch gap-0 min-w-max text-xs">
                                {s.routes.map((r, i) => {
                                  const gap = s.gaps.find(g => g.prevRoute === r);
                                  const routeWidth = Math.max(60, (r.routeDays || 1) * 28);
                                  const gapWidth = gap ? Math.max(24, gap.idleDays * 20) : 0;
                                  const rColor = r.marginPct >= 15 ? "bg-emerald-500" : r.marginPct >= 5 ? "bg-amber-400" : r.marginPct >= 0 ? "bg-orange-400" : "bg-red-500";
                                  return (
                                    <div key={r.orderNr} className="flex items-stretch">
                                      {/* Route block */}
                                      <div
                                        title={`${r.orderNr} | ${r.originCountry}→${r.destCountry} | ${r.routeDays?.toFixed(1)}d | ${r.tripDate}→${r.deliveryDate} | ${r.marginEur >= 0 ? "+" : ""}${Math.round(r.marginEur)}€`}
                                        className={`${rColor} text-white flex flex-col justify-center items-center px-2 py-2 rounded-lg`}
                                        style={{ minWidth: routeWidth }}>
                                        <span className="font-semibold truncate max-w-full">{r.originCountry}→{r.destCountry}</span>
                                        <span className="opacity-80">{r.routeDays?.toFixed(1)}d</span>
                                        <span className="opacity-90 font-medium">{r.marginEur >= 0 ? "+" : ""}{Math.round(r.marginEur)}€</span>
                                      </div>
                                      {/* Gap block */}
                                      {gap && (
                                        <div
                                          title={`Postój: ${gap.idleDays.toFixed(1)} d × stawka dzienna = ${Math.round(gap.idleCostEur)} EUR${gap.prevRoute.driverName !== gap.nextRoute.driverName ? ` (zmiana kierowcy: ${gap.prevRoute.driverName} → ${gap.nextRoute.driverName}, bez dobówki)` : ""}`}
                                          className="flex flex-col justify-center items-center bg-slate-100 border-y border-dashed border-slate-300 text-slate-500 px-2"
                                          style={{ minWidth: gapWidth }}>
                                          <span className="font-semibold text-red-500">{gap.idleDays.toFixed(1)}d</span>
                                          <span className="text-red-400">−{Math.round(gap.idleCostEur)}€</span>
                                          {gap.prevRoute.driverName !== gap.nextRoute.driverName && (
                                            <span className="text-[9px] text-amber-500 font-medium leading-tight text-center">↕kierowca</span>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                              {/* Legend */}
                              <div className="flex gap-3 mt-2 text-xs text-slate-400">
                                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-500 inline-block"/>Rentowna</span>
                                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-400 inline-block"/>Niska marża</span>
                                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-500 inline-block"/>Strata</span>
                                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-slate-200 border border-dashed border-slate-400 inline-block"/>Postój (koszt)</span>
                              </div>
                            </div>

                            {/* KPI row */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border-t border-slate-200 divide-x divide-slate-200">
                              <div className="px-4 py-3 text-center">
                                <div className="text-xs text-slate-400 mb-0.5">Aktywne</div>
                                <div className="font-bold text-slate-700">{s.activeDays} dni</div>
                              </div>
                              <div className="px-4 py-3 text-center">
                                <div className="text-xs text-slate-400 mb-0.5">Postoje</div>
                                <div className="font-bold text-red-500">{s.idleDays.toFixed(1)} d · {fmtEur(s.idleCostEur)}</div>
                              </div>
                              <div className="px-4 py-3 text-center">
                                <div className="text-xs text-slate-400 mb-0.5">Marża tras</div>
                                <div className={`font-bold ${s.routeMarginSum >= 0 ? "text-slate-700" : "text-red-500"}`}>
                                  {s.routeMarginSum >= 0 ? "+" : ""}{fmtEur(s.routeMarginSum)}
                                </div>
                              </div>
                              <div className="px-4 py-3 text-center">
                                <div className="text-xs text-slate-400 mb-0.5">Realna marża</div>
                                <div className={`font-bold ${trueMarginColor}`}>
                                  {s.trueMonthlyMargin >= 0 ? "+" : ""}{fmtEur(s.trueMonthlyMargin)}
                                  <span className="text-xs font-normal ml-1">({fmtPct(s.trueMarginPct)})</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()}
            </>
          )}
        </div>
      )}
      {/* ── Przestoje ── */}
      {activeTab === "idle" && (
        <div className="space-y-4">
          {monthlyData.length === 0 ? (
            <div className="card py-16 text-center text-slate-400">
              <div className="text-4xl mb-3">⏸</div>
              <p className="text-sm">Wczytaj plik TMS z kolumnami dat załadunku i dostawy żeby zobaczyć analizę przestojów</p>
            </div>
          ) : (() => {
            // flatten all gaps across all vehicles/months
            const allGaps = monthlyData.flatMap(s =>
              s.gaps.map(g => ({
                vehicle: s.vehicle,
                dispatcherName: s.routes[0]?.dispatcherName ?? "—",
                prevNr: g.prevRoute.orderNr,
                prevDest: g.prevRoute.destCountry,
                prevDelivery: g.prevRoute.deliveryDate,
                prevDeliveryTs: g.prevRoute.deliveryTimestamp,
                nextNr: g.nextRoute.orderNr,
                nextOrigin: g.nextRoute.originCountry,
                nextPickup: g.nextRoute.tripDate,
                nextPickupTs: g.nextRoute.tripTimestamp,
                idleDays: g.idleDays,
                idleHours: g.idleDays * 24,
                idleCost: g.idleCostEur,
                driverSame: g.prevRoute.driverName === g.nextRoute.driverName,
                isServicePl: g.isServicePl,
              }))
            );

            const gapComment = (h: number, isServicePl?: boolean) => {
              if (isServicePl) return { text: `🔧 Serwis / pojazd w kraju (${Math.round(h)}h) — bez dobówki`, cls: "text-blue-600 font-medium" };
              if (h > 48) return { text: `⚠ Długi postój — brak ładunku (${Math.round(h)}h)`, cls: "text-red-600 font-semibold" };
              if (h > 16) return { text: "Nocleg + oczekiwanie na załadunek", cls: "text-amber-700" };
              if (h >  8) return { text: "Nocleg / odpoczynek kierowcy", cls: "text-amber-600" };
              return { text: "Krótka przerwa / załadunek", cls: "text-slate-500" };
            };

            const totalIdleCost = allGaps.reduce((s,g)=>s+g.idleCost,0);
            const longStops = allGaps.filter(g=>g.idleHours>48).length;
            const totalFracht = kpiData.reduce((s,d)=>s+d.frachtEur,0);

            // group by dispatcher → vehicle
            const byDisp: Record<string, Record<string, typeof allGaps>> = {};
            for (const g of allGaps) {
              if (!byDisp[g.dispatcherName]) byDisp[g.dispatcherName] = {};
              if (!byDisp[g.dispatcherName][g.vehicle]) byDisp[g.dispatcherName][g.vehicle] = [];
              byDisp[g.dispatcherName][g.vehicle].push(g);
            }
            const dispOrder = Object.keys(byDisp).sort();

            return (
              <>
                {/* Summary banner */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="card py-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Łączny koszt postojów</p>
                    <p className="text-xl font-bold text-amber-600">−{fmtEur(totalIdleCost)}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{totalFracht>0?`${(totalIdleCost/totalFracht*100).toFixed(1)}% frachtu`:""}</p>
                  </div>
                  <div className="card py-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Marża tras</p>
                    <p className="text-xl font-bold text-slate-700">{fmtEur(kpiData.reduce((s,d)=>s+d.marginEur,0))}</p>
                  </div>
                  <div className="card py-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Marża po odjęciu postojów</p>
                    {(() => {
                      const real = kpiData.reduce((s,d)=>s+d.marginEur,0) - totalIdleCost;
                      return <p className={`text-xl font-bold ${real>=0?"text-emerald-600":"text-red-600"}`}>{fmtEur(real)}<span className="text-sm font-normal text-slate-400 ml-1">{totalFracht>0?`(${(real/totalFracht*100).toFixed(1)}%)`:""}</span></p>;
                    })()}
                  </div>
                  <div className="card py-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Długie postoje &gt;48h</p>
                    <p className={`text-xl font-bold ${longStops>0?"text-red-600":"text-emerald-600"}`}>{longStops}</p>
                    <p className="text-xs text-slate-400 mt-0.5">z {allGaps.length} przerw łącznie</p>
                  </div>
                </div>

                {/* Info */}
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                  <b>Koszty postojów</b> to czas między rozładunkiem trasy N a załadunkiem trasy N+1 dla tego samego pojazdu.
                  Kierowca i pojazd generują koszty stałe ({fmtEur(200)}/dzień) niezależnie od tego czy jedzie.
                  Postoje &gt;48h to sygnał do analizy — brak zlecenia, awaria, weekend, oczekiwanie na załadunek?
                </div>

                {/* Per dispatcher sections */}
                {dispOrder.map(dispName => {
                  const vehicles = byDisp[dispName];
                  const dispTotal = Object.values(vehicles).flat().reduce((s,g)=>s+g.idleCost,0);
                  const dispLong  = Object.values(vehicles).flat().filter(g=>g.idleHours>48).length;

                  return (
                    <div key={dispName} className="space-y-2">
                      {/* Dispatcher header */}
                      <div className="flex items-center justify-between bg-slate-800 text-white px-5 py-3 rounded-xl">
                        <span className="font-semibold">{dispName}</span>
                        <div className="flex gap-6 text-sm">
                          {dispLong > 0 && <span className="text-red-300">⚠ {dispLong} długich postojów</span>}
                          <span>Koszt postojów: <b className="text-amber-300">−{fmtEur(dispTotal)}</b></span>
                        </div>
                      </div>

                      {/* Per vehicle tables */}
                      {Object.keys(vehicles).sort((a,b) => {
                        const ca = vehicles[a].reduce((s,g)=>s+g.idleCost,0);
                        const cb = vehicles[b].reduce((s,g)=>s+g.idleCost,0);
                        return cb - ca; // sort by idle cost desc
                      }).map(veh => {
                        const gaps = vehicles[veh];
                        const vehTotal = gaps.reduce((s,g)=>s+g.idleCost,0);
                        const vehLong  = gaps.filter(g=>g.idleHours>48).length;

                        return (
                          <div key={veh} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                            {/* Vehicle header */}
                            <div className="flex items-center justify-between px-5 py-2.5 bg-slate-50 border-b border-slate-200">
                              <div className="flex items-center gap-3">
                                <span className="font-bold text-slate-800 text-sm">🚛 {veh}</span>
                                <span className="text-xs text-slate-400">{gaps.length} przerw</span>
                                {vehLong > 0 && <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-semibold rounded-full">{vehLong}× &gt;48h</span>}
                              </div>
                              <span className="text-sm font-bold text-amber-600">−{fmtEur(vehTotal)}</span>
                            </div>

                            {/* Gaps table */}
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-slate-400 uppercase tracking-wide text-[10px]">
                                    <th className="text-left px-4 py-2">Po trasie</th>
                                    <th className="text-left px-3 py-2">Rozładunek</th>
                                    <th className="text-left px-3 py-2">Kolejny załadunek</th>
                                    <th className="text-right px-3 py-2">Godziny</th>
                                    <th className="text-right px-3 py-2">Dni</th>
                                    <th className="text-right px-3 py-2">Koszt</th>
                                    <th className="text-left px-3 py-2">Komentarz</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {gaps.map((g, i) => {
                                    const { text, cls } = gapComment(g.idleHours, g.isServicePl);
                                    const rowBg = g.isServicePl ? "bg-blue-50" : g.idleHours > 48 ? "bg-red-50" : g.idleHours > 16 ? "bg-amber-50" : "";
                                    return (
                                      <tr key={i} className={rowBg}>
                                        <td className="px-4 py-2 font-mono text-slate-600">{g.prevNr}</td>
                                        <td className="px-3 py-2 text-slate-600">
                                          <span className="font-semibold">{g.prevDest}</span>
                                          <span className="text-slate-400 ml-1">{g.prevDelivery}</span>
                                        </td>
                                        <td className="px-3 py-2 text-slate-600">
                                          <span className="font-semibold">{g.nextOrigin}</span>
                                          <span className="text-slate-400 ml-1">{g.nextPickup}</span>
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-700">{g.idleHours.toFixed(1)}h</td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-700">{g.idleDays.toFixed(2)}</td>
                                        <td className="px-3 py-2 text-right font-bold text-amber-700">−{fmtEur(g.idleCost)}</td>
                                        <td className={`px-3 py-2 ${cls}`}>{text}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                                <tfoot>
                                  <tr className="bg-slate-50 border-t border-slate-200">
                                    <td colSpan={5} className="px-4 py-2 text-xs font-semibold text-slate-600 uppercase">Suma postojów — {veh}</td>
                                    <td className="px-3 py-2 text-right font-bold text-amber-700">−{fmtEur(vehTotal)}</td>
                                    <td className="px-3 py-2 text-xs text-slate-400">{gaps.length} przerw · {gaps.filter(g=>g.idleHours>48).length} krytycznych</td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </>
            );
          })()}
        </div>
      )}

      {/* ── Config ── */}
      {activeTab === "config" && (
        <div className="space-y-5">
          {/* Add dispatcher */}
          <div className="card">
            <h3 className="font-bold text-slate-800 mb-3">Dodaj dyspozytora</h3>
            <div className="flex gap-2 flex-wrap">
              <input value={newDispName} onChange={e=>setNewDispName(e.target.value)} placeholder="Imię i nazwisko"
                className="flex-1 min-w-[180px] px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              <input value={newDispEmail} onChange={e=>setNewDispEmail(e.target.value)} placeholder="Email (opcjonalnie)"
                className="flex-1 min-w-[180px] px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              <button onClick={addDispatcher} disabled={!newDispName.trim()}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                Dodaj
              </button>
            </div>
          </div>

          {/* Vehicle assignment */}
          <div className="card p-0 overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 border-b flex items-center justify-between flex-wrap gap-2">
              <div>
                <h3 className="font-bold text-slate-800">Przypisanie pojazdów do dyspozytorów</h3>
                <p className="text-xs text-slate-500 mt-0.5">{vehicles.filter(v=>configTypeFilter==="all"||v.vehicle_type===configTypeFilter).length} pojazdów</p>
              </div>
              <div className="flex gap-1">
                {(["all","ciągnik","naczepa"] as const).map(t => (
                  <button key={t} onClick={()=>setConfigTypeFilter(t)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                      configTypeFilter===t ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                    {t==="all"?"Wszystkie":t==="ciągnik"?"🚛 Ciągniki":"🚌 Naczepy"}
                  </button>
                ))}
              </div>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Rejestracja</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Typ</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Marka</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Dyspozytor</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase">Zmień</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 max-h-[500px] overflow-y-auto">
                {vehicles.filter(v => configTypeFilter==="all" || v.vehicle_type===configTypeFilter).map(v => (
                  <tr key={v.reg} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-mono font-semibold text-slate-800">{v.reg}</td>
                    <td className="px-4 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${v.vehicle_type==="ciągnik"?"bg-blue-100 text-blue-700":"bg-slate-100 text-slate-600"}`}>
                        {v.vehicle_type==="ciągnik"?"CIĄ":"NAC"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-600 text-xs">{v.brand ?? "—"}</td>
                    <td className="px-4 py-2">
                      {v.dispatcher_id && dispById[v.dispatcher_id]
                        ? <span className="text-blue-700 font-medium text-sm">{dispById[v.dispatcher_id].name}</span>
                        : <span className="text-slate-400 text-xs italic">Nieprzypisany</span>}
                    </td>
                    <td className="px-4 py-2">
                      {assigningVehicle === v.reg ? (
                        <div className="flex gap-1 flex-wrap">
                          <select defaultValue={v.dispatcher_id ?? ""}
                            onChange={e => assignVehicle(v.reg, e.target.value || null)}
                            className="px-2 py-1 border border-slate-200 rounded text-xs bg-white focus:ring-2 focus:ring-blue-500 outline-none">
                            <option value="">— Nieprzypisany —</option>
                            {dispatchers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                          <button onClick={()=>setAssigningVehicle(null)} className="text-slate-400 hover:text-slate-700 text-xs px-2">✕</button>
                        </div>
                      ) : (
                        <button onClick={()=>setAssigningVehicle(v.reg)}
                          className="text-xs text-blue-600 hover:text-blue-800 underline">Zmień</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {/* ── Loss Analysis Modal ── */}
      {analysisRoute && (() => {
        const r = analysisRoute;
        const bd = r.breakdown;
        const costs = [
          { key: "Paliwo",      val: bd.fuel,      icon: "⛽", color: "bg-orange-500" },
          { key: "Kierowca",    val: bd.driver,    icon: "👤", color: "bg-blue-500" },
          { key: "Myto",        val: bd.toll,      icon: "🛣️", color: "bg-purple-500" },
          { key: "Leasing cią.", val: bd.leasing,         icon: "💳", color: "bg-teal-500" },
          { key: "Leasing nacz.", val: bd.trailerLeasing, icon: "🚛", color: "bg-teal-400" },
          { key: "Ubezp.",        val: bd.insurance,     icon: "🛡️", color: "bg-indigo-500" },
          { key: "Serwis",      val: bd.service,   icon: "🔧", color: "bg-slate-500" },
          { key: "AdBlue",      val: bd.adblue,    icon: "🔵", color: "bg-cyan-500" },
          { key: "Postój",      val: bd.idle,      icon: "⏸️", color: "bg-yellow-500" },
        ].sort((a,b) => b.val - a.val);

        // Find biggest culprit
        const biggest = costs[0];
        const biggestPct = r.frachtEur > 0 ? (biggest.val / r.frachtEur * 100) : 0;

        // Break-even analysis
        const freightForZero  = Math.ceil(r.totalCost);
        const freightFor15    = Math.ceil(r.totalCost / 0.85);
        const freightDeltaZero = freightForZero - r.frachtEur;
        const freightDelta15   = freightFor15 - r.frachtEur;

        // Per-km comparison
        const avgCostPerKm = 1.85; // rough fleet avg EUR/km (all costs)

        // Diagnoza
        const diagnoses: string[] = [];
        if (r.frachtEur / r.distanceKm < 1.5)
          diagnoses.push(`Niski fracht per km: ${(r.frachtEur/r.distanceKm).toFixed(2)} €/km — rynek zazwyczaj wymaga min. 1.50 €/km`);
        if (bd.toll / r.frachtEur > 0.25)
          diagnoses.push(`Myto stanowi ${(bd.toll/r.frachtEur*100).toFixed(0)}% frachtu — trasa przez drogi kraje (DE/AT/CH/FR)`);
        if (bd.driver / r.frachtEur > 0.35)
          diagnoses.push(`Koszt kierowcy ${(bd.driver/r.frachtEur*100).toFixed(0)}% frachtu — ${r.routeDays?.toFixed(1)} d × 181,95 EUR = ${Math.round(bd.driver)} EUR przy frachcie ${Math.round(r.frachtEur)} EUR`);
        if (r.distanceKm < 300)
          diagnoses.push(`Krótka trasa (${Math.round(r.distanceKm)} km) — wysokie koszty stałe (leasing, ubezp.) na małej odległości`);
        const totalLeasing = bd.leasing + bd.trailerLeasing;
        if (totalLeasing / r.frachtEur > 0.20)
          diagnoses.push(`Leasing (cią. + nacz.) pochłania ${(totalLeasing/r.frachtEur*100).toFixed(0)}% frachtu — ${Math.round(totalLeasing)} € na tej trasie`);
        if (diagnoses.length === 0) {
          if (r.marginEur < 0)
            diagnoses.push(`Łączne koszty (${Math.round(r.totalCost)} €) przekraczają fracht (${Math.round(r.frachtEur)} €) o ${Math.abs(Math.round(r.marginEur))} €`);
          else
            diagnoses.push(`Marża ${fmtPct(r.marginPct)} — koszty (${Math.round(r.totalCost)} €) poniżej frachtu (${Math.round(r.frachtEur)} €), rezerwa ${Math.round(r.marginEur)} €`);
        }

        const isLoss = r.marginPct < 0;
        const diagColor = isLoss
          ? { bg: "bg-red-50", border: "border-red-200", title: "text-red-700", text: "text-red-800", arrow: "text-red-500" }
          : { bg: "bg-amber-50", border: "border-amber-200", title: "text-amber-700", text: "text-amber-800", arrow: "text-amber-500" };

        return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={e => e.target === e.currentTarget && setAnalysisRoute(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className={`px-6 py-4 rounded-t-2xl ${r.marginPct < 0 ? "bg-red-600" : "bg-amber-500"} text-white`}>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold">Analiza trasy — {r.orderNr}</h2>
                  <p className="text-sm opacity-90 font-semibold">{r.client}</p>
                  <p className="text-sm opacity-80">{r.vehicle} · {r.originCountry} → {r.destCountry} · {Math.round(r.totalKm)} km (L+P) · {r.routeDays?.toFixed(1)} d</p>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-black">{fmtPct(r.marginPct)}</div>
                  <div className="text-xs opacity-75">{Math.round(r.marginEur)} € marży</div>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-5">
              {/* Diagnosis */}
              <div className={`${diagColor.bg} border ${diagColor.border} rounded-xl p-4`}>
                <p className={`text-xs font-bold ${diagColor.title} uppercase tracking-wide mb-2`}>
                  🔍 {isLoss ? "Diagnoza przyczyny straty" : "Analiza kosztów trasy"}
                </p>
                <ul className="space-y-1.5">
                  {diagnoses.map((d,i) => (
                    <li key={i} className={`flex items-start gap-2 text-sm ${diagColor.text}`}>
                      <span className={`${diagColor.arrow} mt-0.5`}>→</span>{d}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Cost breakdown bars */}
              <div>
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Struktura kosztów vs fracht</p>
                <div className="space-y-2">
                  {/* Fracht bar */}
                  <div className="flex items-center gap-3">
                    <span className="text-xs w-20 text-right text-slate-500">Fracht</span>
                    <div className="flex-1 bg-slate-100 rounded-full h-5 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{width:"100%"}} />
                    </div>
                    <span className="text-xs w-20 font-bold text-emerald-700">{Math.round(r.frachtEur)} €</span>
                    <span className="text-xs w-10 text-slate-400">100%</span>
                  </div>
                  {/* Cost bars */}
                  {costs.filter(c => c.val > 0).map(c => {
                    const pct = r.frachtEur > 0 ? Math.min((c.val/r.frachtEur)*100, 100) : 0;
                    const isHigh = pct > 30;
                    return (
                      <div key={c.key} className="flex items-center gap-3">
                        <span className="text-xs w-20 text-right text-slate-500">{c.icon} {c.key}</span>
                        <div className="flex-1 bg-slate-100 rounded-full h-4 overflow-hidden">
                          <div className={`h-full rounded-full ${isHigh ? "bg-red-500" : c.color} opacity-80`}
                            style={{width:`${pct}%`}} />
                        </div>
                        <span className={`text-xs w-20 font-semibold ${isHigh?"text-red-600":"text-slate-700"}`}>
                          {Math.round(c.val)} €
                        </span>
                        <span className={`text-xs w-10 ${isHigh?"text-red-600 font-bold":"text-slate-400"}`}>
                          {pct.toFixed(0)}%
                        </span>
                      </div>
                    );
                  })}
                  {/* Total */}
                  <div className="flex items-center gap-3 border-t pt-2">
                    <span className="text-xs w-20 text-right font-bold text-slate-700">RAZEM</span>
                    <div className="flex-1 bg-slate-100 rounded-full h-5 overflow-hidden">
                      <div className="h-full bg-red-600 rounded-full"
                        style={{width:`${Math.min((r.totalCost/r.frachtEur)*100,150)}%`}} />
                    </div>
                    <span className="text-xs w-20 font-bold text-red-700">{Math.round(r.totalCost)} €</span>
                    <span className="text-xs w-10 text-red-600 font-bold">
                      {r.frachtEur>0?(r.totalCost/r.frachtEur*100).toFixed(0):0}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Per-km */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 rounded-xl p-3 text-center">
                  <div className="text-xs text-slate-500 mb-1">Koszt HBM / km</div>
                  <div className={`text-xl font-bold ${r.costPerKm > 1.7 ? "text-red-600" : "text-slate-800"}`}>
                    {r.costPerKm.toFixed(2)} €/km
                  </div>
                  <div className="text-xs text-slate-400">śr. flota ~1.50–1.70 €/km</div>
                </div>
                <div className="bg-slate-50 rounded-xl p-3 text-center">
                  <div className="text-xs text-slate-500 mb-1">Fracht / km</div>
                  <div className={`text-xl font-bold ${r.revenuePerKm < 1.5 ? "text-red-600" : "text-emerald-600"}`}>
                    {r.revenuePerKm.toFixed(2)} €/km
                  </div>
                  <div className="text-xs text-slate-400">min. rentowność ~1.80 €/km</div>
                </div>
              </div>

              {/* Break-even */}
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <p className="text-xs font-bold text-blue-700 uppercase tracking-wide mb-3">📈 Co musi się zmienić?</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="text-center">
                    <div className="text-lg font-black text-blue-800">{freightForZero.toLocaleString("pl-PL")} €</div>
                    <div className="text-xs text-blue-600">fracht na próg 0%</div>
                    <div className="text-xs text-slate-500 mt-0.5">+{freightDeltaZero.toLocaleString("pl-PL")} € do obecnego</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-black text-emerald-700">{freightFor15.toLocaleString("pl-PL")} €</div>
                    <div className="text-xs text-emerald-600">fracht na marżę 15%</div>
                    <div className="text-xs text-slate-500 mt-0.5">+{freightDelta15.toLocaleString("pl-PL")} € do obecnego</div>
                  </div>
                </div>
              </div>

              <button onClick={() => setAnalysisRoute(null)}
                className="w-full py-2.5 border border-slate-200 text-slate-600 text-sm rounded-xl hover:border-slate-400 transition-colors">
                Zamknij
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}