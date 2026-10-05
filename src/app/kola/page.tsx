"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { calculateRoute, FLEET } from "@/lib/calculator";
import { useSettings } from "@/lib/settings-context";
import {
  analyzeCycles,
  fleetCycleSummary,
  type TruckCycle,
  type CycleRoute,
  type CycleRouteInput,
  type CycleOptions,
  type FleetCycleSummary,
} from "@/lib/cycleAnalyzer";
import { type CalcSettings } from "@/lib/calculator";

// ─── Dispatcher & Vehicle types ───────────────────────────────
interface Dispatcher {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
}

interface Vehicle {
  reg: string;
  brand?: string | null;
  model?: string | null;
  vehicle_type: string | null;
  dispatcher_id?: string | null;
  avg_fuel_l100: number | null;
  year_produced: number | null;
  leasing_eur_mo: number | null;
  insurance_eur_mo: number | null;
  service_cost_km: number | null;
  is_active?: boolean;
}

interface DispatcherPool {
  id: string;
  name: string;
  vehicles: string[];
  ciagniki: string[];
  naczepy: string[];
  cycles: TruckCycle[];
  routesCount: number;
  totalKm: number;
  frachtEur: number;
  costEur: number;
  marginEur: number;
  marginPct: number;
  avgMarginPerCyclePct: number;
  losses: number;
  lowMargin: number;
  breakeven: number;
  profitable: number;
}

// ─── Format helpers ────────────────────────────────────────────
function fmtEur(n: number) {
  return n.toLocaleString("pl-PL", { maximumFractionDigits: 0 }) + " €";
}
function fmtEurPerKm(n: number) {
  return n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €/km";
}
function fmtKm(n: number) {
  return n.toLocaleString("pl-PL", { maximumFractionDigits: 0 }) + " km";
}
function fmtPct(n: number) {
  return n.toFixed(1) + "%";
}
function fmtDays(n: number) {
  return n.toFixed(1) + " d";
}

function marginTextColor(pct: number) {
  if (pct >= 15) return "text-emerald-600 font-semibold";
  if (pct >= 5)  return "text-amber-600 font-semibold";
  if (pct >= 0)  return "text-orange-600 font-semibold";
  return "text-red-600 font-bold";
}
function marginBorderColor(pct: number) {
  if (pct >= 15) return "border-l-emerald-500";
  if (pct >= 5)  return "border-l-amber-500";
  if (pct >= 0)  return "border-l-orange-500";
  return "border-l-red-500";
}
function marginColor(pct: number) {
  if (pct >= 15) return "text-emerald-600";
  if (pct >= 5)  return "text-amber-600";
  if (pct >= 0)  return "text-orange-600";
  return "text-red-600";
}

// ─── Parser utility functions ─────────────────────────────────
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
  const n = parseFloat(s);
  if (!isNaN(n) && n > 40000) {
    const d = new Date((n - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s.length >= 10 ? s.slice(0, 10) : "";
}

function daysBetween(a: string, b: string): number {
  if (!a || !b) return 0;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function toTimestamp(s: string): number | undefined {
  if (!s) return undefined;
  const n = parseFloat(s);
  if (!isNaN(n) && n > 40000) return Math.round((n - 25569) * 86400 * 1000);
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const iso = dmy[4]
      ? `${dmy[3]}-${dmy[2]}-${dmy[1]}T${dmy[4]}:${dmy[5]}:${dmy[6] ?? "00"}`
      : `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.getTime();
}

// ─── TMS Parser → CycleRouteInput[] ──────────────────────────
function parseTmsForCycles(
  ab: ArrayBuffer,
  vehicles: Vehicle[],
  eurRate: number,
  fuelPrice: number,
  settings: CalcSettings | undefined,
): CycleRouteInput[] {
  const wb = XLSX.read(ab, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const all = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" }) as string[][];

  // Detect header row
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

  const vehMap: Record<string, Vehicle> = {};
  for (const v of vehicles) vehMap[v.reg] = v;

  // Trailer leasing map
  const trailerLeasingMap: Record<string, number> = {};
  for (const v of vehicles) {
    if (v.vehicle_type === "naczepa" && v.reg && v.leasing_eur_mo)
      trailerLeasingMap[v.reg] = Number(v.leasing_eur_mo);
  }
  const allTrailerLeasings = Object.values(trailerLeasingMap);
  const fleetAvgTrailerLeasing = allTrailerLeasings.length
    ? allTrailerLeasings.reduce((a, b) => a + b, 0) / allTrailerLeasings.length
    : undefined;

  const routes: CycleRouteInput[] = [];

  for (const row of all.slice(hIdx + 1)) {
    const orderNr = get(row, "Nr pełny", "Nr pe");
    if (!orderNr) continue;

    const kmLadOdo    = parseFloat(get(row, "lad. wg licznika") || "0");
    const kmPusteOdo  = parseFloat(get(row, "puste wg licznika") || "0");
    const kmLadMapa   = parseFloat(get(row, "km ład", "km wg", "Km") || "0");
    const kmPusteMapa = parseFloat(get(row, "puste km", "km puste", "km pusty") || "0");

    const distanceKm = kmLadOdo > 0 ? kmLadOdo : kmLadMapa;
    const emptyKm    = kmLadOdo > 0
      ? (kmPusteOdo  > 0 ? kmPusteOdo  : undefined)
      : (kmPusteMapa > 0 ? kmPusteMapa : undefined);

    const frachtRaw = get(row, "fracht z wal", "fracht");
    let frachtEur = parseFracht(frachtRaw, eurRate);
    const wymagania = get(row, "wymagania");
    const stawkaMatch = wymagania.match(/stawka\s+ko[ńn]cowa\s+([\d\s,.]+)\s*[€eE]/i);
    if (stawkaMatch) {
      const finalRate = parseFloat(stawkaMatch[1].replace(/[\s]/g, "").replace(",", "."));
      if (!isNaN(finalRate) && finalRate > frachtEur) frachtEur = finalRate;
    }

    // Allow flat-rate orders through (km ≤ 5, fracht > 0) — only skip genuine junk rows
    if (distanceKm < 0.5 && frachtEur < 10) continue;

    const vehicle       = get(row, "ciągnik", "ciagnik", "pojazd").toUpperCase();
    const naczepaReg    = get(row, "naczepa", "naczepa:", "naczepa ").toUpperCase();
    const client        = get(row, "zleceniodawca", "klient", "nadawca") || "—";
    const originCountry = get(row, "zał. kraj", "zal. kraj", "kraj za").toUpperCase() || "PL";
    const destCountry   = get(row, "roz. kraj", "kraj ro").toUpperCase() || "PL";
    const driverName    = get(row, "kierowca 1", "kierowca1", "kierowca", "driver").trim();

    const pickupRaw   = get(row, "podjęcie rzeczywiste", "podjecie rzeczywiste", "podjęcie", "podjecie", "data załadunku");
    const deliveryRaw = get(row, "dostarczenie rzeczywiste", "dostarczenie", "data rozładunku");
    const tripDate    = toDateKey(pickupRaw);
    const deliveryDate = toDateKey(deliveryRaw);
    if (!tripDate) continue;

    const pickupTs   = toTimestamp(pickupRaw);
    const deliveryTs = toTimestamp(deliveryRaw);
    const totalKm    = distanceKm + (emptyKm ?? 0);
    const maxReasonableDays = Math.max(2, Math.ceil((totalKm || 200) / 150));

    let routeDays: number | undefined;
    if (pickupTs !== undefined && deliveryTs !== undefined && deliveryTs > pickupTs) {
      const dur = (deliveryTs - pickupTs) / 86400000;
      if (dur <= maxReasonableDays)
        routeDays = Math.round(dur * 100) / 100;
    } else if (tripDate && deliveryDate && deliveryDate >= tripDate) {
      const rawDays = Math.max(1, daysBetween(tripDate, deliveryDate) + 1);
      if (rawDays <= maxReasonableDays) routeDays = rawDays;
    }

    // Toll from TMS
    const tmsTollEurRaw = parseFloat(get(row, "myto na trasie eur", "myto eur", "toll eur") || "0");
    const tmsTollPlnRaw = parseFloat(get(row, "myto na trasie pln", "myto pln", "opłata drogowa") || "0");
    const tmsTollEur = tmsTollEurRaw > 0
      ? tmsTollEurRaw
      : tmsTollPlnRaw > 0 ? Math.round((tmsTollPlnRaw / eurRate) * 100) / 100 : 0;

    // Margin hint from TMS (for fracht estimation)
    const tmsMarzaPerKm = parseFloat(get(row, "marża eur na 1 km", "marża eur") || "0") || 0;

    const vData = vehMap[vehicle];
    const trailerLeasingEurMo = (naczepaReg && trailerLeasingMap[naczepaReg])
      ? trailerLeasingMap[naczepaReg]
      : fleetAvgTrailerLeasing;

    const calcBase = {
      originCountry, destCountry, distanceKm, emptyKm,
      fuelPriceEurL: fuelPrice,
      transitCountries: [originCountry, destCountry],
      avgFuelL100:          vData?.avg_fuel_l100  ?? FLEET.avgFuelL100,
      vehicleYearProduced:  vData?.year_produced  ?? undefined,
      leasingEurMo:         vData?.leasing_eur_mo ?? undefined,
      trailerLeasingEurMo,
      insuranceEurMo:       vData?.insurance_eur_mo  ?? undefined,
      serviceCostKmOverride: vData?.service_cost_km  ?? undefined,
      routeDays,
      overrideTollEur: tmsTollEur || undefined,
    };

    // Estimate fracht when missing
    if (frachtEur === 0 && tmsMarzaPerKm > 0) {
      const bd0 = calculateRoute({ ...calcBase, freightEur: 1 }, settings);
      frachtEur = Math.round((bd0.total + tmsMarzaPerKm * distanceKm) * 100) / 100;
    }

    const bd = calculateRoute({ ...calcBase, freightEur: frachtEur }, settings);

    const label =
      bd.marginPct >= 15 ? "Rentowna"
      : bd.marginPct >= 5  ? "Niska marża"
      : bd.marginPct >= 0  ? "Próg"
      : "STRATA";

    routes.push({
      orderNr,
      vehicle,
      label,
      client,
      originCountry,
      destCountry,
      distanceKm,
      emptyKm,
      totalKm,
      frachtEur,
      totalCost:  bd.total,
      marginEur:  bd.marginEur,
      marginPct:  bd.marginPct,
      routeDays:  bd.routeDays,
      tripDate,
      deliveryDate: deliveryDate || tripDate,
      tripTimestamp:    pickupTs,
      deliveryTimestamp: deliveryTs,
      driverName,
    });
  }

  return routes;
}

// ─── Fleet Summary Bar ─────────────────────────────────────────
function FleetSummaryBar({ summary }: { summary: FleetCycleSummary }) {
  const stats = [
    { label: "Kółka", value: summary.totalCycles.toString() },
    { label: "Trasy", value: summary.totalRoutes.toString() },
    { label: "Flat-rate", value: summary.totalFlatRateRoutes.toString(), warn: summary.totalFlatRateRoutes > 0 },
    { label: "Km łącznie", value: fmtKm(summary.totalKm) },
    { label: "Fracht", value: fmtEur(summary.totalFreightEur) },
    { label: "Koszty", value: fmtEur(summary.totalCostEur) },
    { label: "Marża", value: fmtEur(summary.totalMarginEur), highlight: summary.totalMarginEur >= 0 },
    { label: "Marża %", value: fmtPct(summary.avgMarginPct) },
    { label: "Śr. czas kółka", value: fmtDays(summary.avgDurationDays) },
    { label: "Śr. fracht/kółko", value: fmtEur(summary.avgFreightPerCycle) },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      {stats.map(s => (
        <div key={s.label} className="bg-white rounded-xl border border-gray-200 px-4 py-3 shadow-sm">
          <div className="text-xs text-gray-500 mb-0.5">{s.label}</div>
          <div className={`text-lg font-bold ${
            s.highlight === false ? "text-red-600"
            : s.highlight ? "text-emerald-600"
            : s.warn ? "text-violet-600"
            : "text-gray-800"
          }`}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Route row in cycle table ──────────────────────────────────
function RouteRow({ r }: { r: CycleRoute }) {
  return (
    <tr className={r.isFlatRate ? "bg-violet-50" : "hover:bg-gray-50"}>
      <td className="px-3 py-1.5 text-xs text-gray-500">{r.tripDate}</td>
      <td className="px-3 py-1.5 text-xs font-mono">{r.orderNr}</td>
      <td className="px-3 py-1.5 text-xs">
        <span className="font-medium">{r.originCountry}</span>
        <span className="text-gray-400 mx-1">→</span>
        <span className="font-medium">{r.destCountry}</span>
        {r.client && r.client !== "—" && (
          <span className="ml-1 text-gray-400 text-xs">({r.client})</span>
        )}
      </td>
      <td className="px-3 py-1.5 text-xs text-right">
        {r.isFlatRate ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 text-xs font-semibold">
            FLAT {r.distanceKm} km
          </span>
        ) : (
          <span>{fmtKm(r.distanceKm)}</span>
        )}
      </td>
      <td className="px-3 py-1.5 text-xs text-right text-gray-500">{fmtKm(r.emptyKm)}</td>
      <td className="px-3 py-1.5 text-xs text-right font-medium">{fmtEur(r.frachtEur)}</td>
      <td className="px-3 py-1.5 text-xs text-right text-gray-500">{fmtEur(r.totalCost)}</td>
      <td className={`px-3 py-1.5 text-xs text-right ${marginTextColor(r.marginPct)}`}>
        {fmtEur(r.marginEur)} ({fmtPct(r.marginPct)})
      </td>
      <td className="px-3 py-1.5 text-xs text-gray-500">
        {r.driverName !== "—" ? r.driverName : ""}
      </td>
    </tr>
  );
}

// ─── Cycle Card ────────────────────────────────────────────────
function CycleCard({ cycle, expanded, onToggle, dispatcherName }: {
  cycle: TruckCycle;
  expanded: boolean;
  onToggle: () => void;
  dispatcherName?: string;
}) {
  const borderColor = marginBorderColor(cycle.marginPct);
  return (
    <div className={`bg-white rounded-xl border border-gray-200 border-l-4 ${borderColor} shadow-sm mb-4`}>
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full text-left px-5 py-4 flex items-start gap-4 flex-wrap md:flex-nowrap"
      >
        {/* Cycle index badge */}
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-sm font-bold text-gray-700 mt-0.5">
          #{cycle.cycleIndex}
        </div>

        {/* Dates + duration */}
        <div className="flex-shrink-0 min-w-[140px]">
          <div className="text-sm font-semibold text-gray-800">
            {cycle.startDate} → {cycle.endDate}
          </div>
          <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span>{fmtDays(cycle.durationDays)} trasy</span>
            {cycle.pauseDaysAfter > 0 && (
              <span className="text-blue-500">
                + {fmtDays(cycle.pauseDaysAfter)} przerwa PL
              </span>
            )}
            {dispatcherName && (
              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.2 bg-blue-50 text-blue-700 border border-blue-200 rounded">
                👤 {dispatcherName}
              </span>
            )}
          </div>
        </div>

        {/* Routes count */}
        <div className="flex-shrink-0 text-center px-2">
          <div className="text-lg font-bold text-gray-800">{cycle.routeCount}</div>
          <div className="text-xs text-gray-400">tras</div>
          {cycle.flatRateCount > 0 && (
            <div className="text-xs text-violet-600 font-medium mt-0.5">
              {cycle.flatRateCount}× flat
            </div>
          )}
        </div>

        {/* Km */}
        <div className="flex-shrink-0 text-center px-2">
          <div className="text-sm font-semibold text-gray-700">{fmtKm(cycle.totalKmLaden)}</div>
          <div className="text-xs text-gray-400">ładowne</div>
          {cycle.totalKmEmpty > 0 && (
            <div className="text-xs text-gray-400">{fmtKm(cycle.totalKmEmpty)} puste</div>
          )}
        </div>

        {/* Revenue breakdown */}
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-3 ml-2">
          <div>
            <div className="text-xs text-gray-400">Fracht</div>
            <div className="text-sm font-semibold">{fmtEur(cycle.totalFreightEur)}</div>
            {cycle.flatRateFreightEur > 0 && (
              <div className="text-xs text-violet-600">{fmtEur(cycle.flatRateFreightEur)} flat</div>
            )}
          </div>
          <div>
            <div className="text-xs text-gray-400">Koszty</div>
            <div className="text-sm text-gray-600">{fmtEur(cycle.totalCostEur)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400">Marża</div>
            <div className={`text-sm ${marginTextColor(cycle.marginPct)}`}>
              {fmtEur(cycle.marginEur)}
            </div>
            <div className={`text-xs ${marginTextColor(cycle.marginPct)}`}>
              {fmtPct(cycle.marginPct)}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-400">Fracht/dzień</div>
            <div className="text-sm font-medium">{fmtEur(cycle.revenuePerDay)}</div>
            <div className="text-xs text-gray-400">{fmtEurPerKm(cycle.revenuePerKm)}</div>
          </div>
        </div>

        {/* Expand toggle */}
        <div className="flex-shrink-0 text-gray-400 text-lg mt-1 ml-auto">
          {expanded ? "▲" : "▼"}
        </div>
      </button>

      {/* Expandable route table */}
      {expanded && (
        <div className="border-t border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 border-b border-gray-100">
                <th className="px-3 py-2 text-left font-medium">Data</th>
                <th className="px-3 py-2 text-left font-medium">Nr</th>
                <th className="px-3 py-2 text-left font-medium">Trasa</th>
                <th className="px-3 py-2 text-right font-medium">Km ład.</th>
                <th className="px-3 py-2 text-right font-medium">Km puste</th>
                <th className="px-3 py-2 text-right font-medium">Fracht</th>
                <th className="px-3 py-2 text-right font-medium">Koszt</th>
                <th className="px-3 py-2 text-right font-medium">Marża</th>
                <th className="px-3 py-2 text-left font-medium">Kierowca</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {cycle.routes.map((r, i) => (
                <RouteRow key={`${r.orderNr}-${i}`} r={r} />
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 border-t border-gray-200 font-semibold text-xs">
                <td className="px-3 py-2" colSpan={3}>Razem kółko #{cycle.cycleIndex}</td>
                <td className="px-3 py-2 text-right">{fmtKm(cycle.totalKmLaden)}</td>
                <td className="px-3 py-2 text-right">{fmtKm(cycle.totalKmEmpty)}</td>
                <td className="px-3 py-2 text-right">{fmtEur(cycle.totalFreightEur)}</td>
                <td className="px-3 py-2 text-right">{fmtEur(cycle.totalCostEur)}</td>
                <td className={`px-3 py-2 text-right ${marginTextColor(cycle.marginPct)}`}>
                  {fmtEur(cycle.marginEur)} ({fmtPct(cycle.marginPct)})
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Options Panel ─────────────────────────────────────────────
function OptionsPanel({
  opts, onChange,
}: {
  opts: Required<CycleOptions>;
  onChange: (o: Required<CycleOptions>) => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4 flex flex-wrap gap-6 items-end text-sm">
      <div>
        <label className="block text-xs text-gray-500 mb-1">
          Min. przerwa PL (dni)
        </label>
        <input
          type="number" min={0} max={14} step={0.25}
          value={opts.minBreakDays}
          onChange={e => onChange({ ...opts, minBreakDays: parseFloat(e.target.value) || 0.25 })}
          className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-sm"
        />
        <div className="text-xs text-gray-400 mt-0.5">domyślnie: 0.25 (6h)</div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">
          Flat-rate: max km ład.
        </label>
        <input
          type="number" min={1} max={50} step={1}
          value={opts.flatRateKmMax}
          onChange={e => onChange({ ...opts, flatRateKmMax: parseInt(e.target.value) || 5 })}
          className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-sm"
        />
        <div className="text-xs text-gray-400 mt-0.5">domyślnie: 5 km</div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">
          Flat-rate: min fracht (EUR)
        </label>
        <input
          type="number" min={10} max={2000} step={10}
          value={opts.flatRateMinEur}
          onChange={e => onChange({ ...opts, flatRateMinEur: parseFloat(e.target.value) || 50 })}
          className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-sm"
        />
        <div className="text-xs text-gray-400 mt-0.5">domyślnie: 50 €</div>
      </div>
      <div className="text-xs text-gray-400 max-w-xs self-center">
        Kółko = wyjazd z PL → trasy zagraniczne → powrót do PL. Przerwa ≥ min. przerwa PL zamyka cykl.
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────
export default function KolaPage() {
  const { settings } = useSettings();
  const fileRef = useRef<HTMLInputElement>(null);

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [dispatchers, setDispatchers] = useState<Dispatcher[]>([]);
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const [eurRate, setEurRate] = useState(4.27);
  const [fuelPrice, setFuelPrice] = useState(1.25);

  const [allCycles, setAllCycles] = useState<TruckCycle[]>([]);
  const [summary, setSummary] = useState<FleetCycleSummary | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  // Options
  const [opts, setOpts] = useState<Required<CycleOptions>>({
    minBreakDays:  0.25,
    flatRateKmMax: 5,
    flatRateMinEur: 50,
  });
  const [showOpts, setShowOpts] = useState(false);

  // Filter & expand state
  const [selectedDispatcher, setSelectedDispatcher] = useState<string>("all");
  const [selectedVehicle, setSelectedVehicle] = useState<string>("all");
  const [expandedCycles, setExpandedCycles] = useState<Set<string>>(new Set());
  const [expandAll, setExpandAll] = useState(false);

  // Raw routes — kept so we can re-analyze with new opts without re-parsing
  const [rawRoutes, setRawRoutes] = useState<CycleRouteInput[]>([]);

  // Sync settings
  useEffect(() => {
    if (settings.fuelPriceEurL) setFuelPrice(settings.fuelPriceEurL as number);
    if (settings.plnEurRate)    setEurRate(settings.plnEurRate as number);
  }, [settings.fuelPriceEurL, settings.plnEurRate]);

  // Load vehicles & dispatchers from Supabase
  useEffect(() => {
    Promise.all([
      supabase
        .from("vehicles")
        .select("reg,brand,model,vehicle_type,dispatcher_id,avg_fuel_l100,year_produced,leasing_eur_mo,insurance_eur_mo,service_cost_km,is_active")
        .eq("is_active", true)
        .order("reg"),
      supabase
        .from("dispatchers")
        .select("id,name,email,phone,is_active")
        .eq("is_active", true)
        .order("name"),
    ]).then(([{ data: vData }, { data: dData }]) => {
      setVehicles(vData ?? []);
      setDispatchers(dData ?? []);
      setLoading(false);
    });
  }, []);

  // Map vehicle reg -> Vehicle & Dispatcher info
  const vehMap = useMemo(() => {
    const map = new Map<string, Vehicle>();
    for (const v of vehicles) {
      if (v.reg) map.set(v.reg.toUpperCase(), v);
    }
    return map;
  }, [vehicles]);

  const dispById = useMemo(() => {
    const map = new Map<string, Dispatcher>();
    for (const d of dispatchers) map.set(d.id, d);
    return map;
  }, [dispatchers]);

  const getVehicleDispatcherName = (reg: string): string => {
    const v = vehMap.get(reg.toUpperCase());
    if (!v || !v.dispatcher_id) return "Nieprzypisany";
    return dispById.get(v.dispatcher_id)?.name ?? "Nieznany";
  };

  // Re-analyze when opts change (without re-parsing)
  useEffect(() => {
    if (rawRoutes.length === 0) return;
    const cycles = analyzeCycles(rawRoutes, opts);
    setAllCycles(cycles);
    setSummary(fleetCycleSummary(cycles));
  }, [rawRoutes, opts]);

  // Upload handler
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParsing(true);
    setParseError(null);
    try {
      const ab = await file.arrayBuffer();
      const routes = parseTmsForCycles(ab, vehicles, eurRate, fuelPrice, settings);
      if (routes.length === 0) {
        setParseError("Nie znaleziono tras w pliku. Sprawdź czy to właściwy plik TMS.");
        setParsing(false);
        return;
      }
      setRawRoutes(routes);
      // cycles are computed via the effect above
    } catch (err) {
      console.error(err);
      setParseError("Błąd parsowania pliku. Upewnij się że plik jest eksportem TMS.");
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Dispatcher pools & KPI calculations (similar to Dyspozytorzy tab)
  const dispatcherPools = useMemo(() => {
    if (dispatchers.length === 0 && vehicles.length === 0) return [];

    // Group active vehicles by dispatcher
    const vehByDisp = new Map<string, Vehicle[]>();
    for (const v of vehicles) {
      const key = v.dispatcher_id || "__unassigned__";
      if (!vehByDisp.has(key)) vehByDisp.set(key, []);
      vehByDisp.get(key)!.push(v);
    }

    // Vehicle reg to dispatcher map
    const vehToDispId = new Map<string, string>();
    for (const v of vehicles) {
      if (v.reg) vehToDispId.set(v.reg.toUpperCase(), v.dispatcher_id || "__unassigned__");
    }

    // Group cycles by dispatcher
    const cyclesByDisp = new Map<string, TruckCycle[]>();
    for (const c of allCycles) {
      const dispId = vehToDispId.get(c.vehicleReg.toUpperCase()) || "__unassigned__";
      if (!cyclesByDisp.has(dispId)) cyclesByDisp.set(dispId, []);
      cyclesByDisp.get(dispId)!.push(c);
    }

    const list: DispatcherPool[] = dispatchers.map(d => {
      const myVehicles = vehByDisp.get(d.id) || [];
      const myCycles = cyclesByDisp.get(d.id) || [];
      const ciagniki = myVehicles.filter(v => v.vehicle_type === "ciągnik").map(v => v.reg);
      const naczepy = myVehicles.filter(v => v.vehicle_type === "naczepa").map(v => v.reg);
      const allVehRegs = myVehicles.map(v => v.reg);

      const allRoutes = myCycles.flatMap(c => c.routes);
      const frachtEur = myCycles.reduce((s, c) => s + c.totalFreightEur, 0);
      const costEur = myCycles.reduce((s, c) => s + c.totalCostEur, 0);
      const marginEur = myCycles.reduce((s, c) => s + c.marginEur, 0);
      const marginPct = frachtEur > 0 ? (marginEur / frachtEur) * 100 : 0;
      const totalKm = Math.round(myCycles.reduce((s, c) => s + c.totalKm, 0));
      const avgMarginPerCyclePct = myCycles.length > 0
        ? myCycles.reduce((s, c) => s + c.marginPct, 0) / myCycles.length
        : 0;

      const losses = allRoutes.filter(r => r.marginPct < 0).length;
      const lowMargin = allRoutes.filter(r => r.marginPct >= 0 && r.marginPct < 5).length;
      const breakeven = allRoutes.filter(r => r.marginPct >= 5 && r.marginPct < 15).length;
      const profitable = allRoutes.filter(r => r.marginPct >= 15).length;

      return {
        id: d.id,
        name: d.name,
        vehicles: allVehRegs,
        ciagniki,
        naczepy,
        cycles: myCycles,
        routesCount: allRoutes.length,
        totalKm,
        frachtEur,
        costEur,
        marginEur,
        marginPct,
        avgMarginPerCyclePct,
        losses,
        lowMargin,
        breakeven,
        profitable,
      };
    });

    // Unassigned dispatcher if any
    const unassignedVeh = vehByDisp.get("__unassigned__") || [];
    const unassignedCycles = cyclesByDisp.get("__unassigned__") || [];
    if (unassignedVeh.length > 0 || unassignedCycles.length > 0) {
      const ciagniki = unassignedVeh.filter(v => v.vehicle_type === "ciągnik").map(v => v.reg);
      const naczepy = unassignedVeh.filter(v => v.vehicle_type === "naczepa").map(v => v.reg);
      const allRoutes = unassignedCycles.flatMap(c => c.routes);
      const frachtEur = unassignedCycles.reduce((s, c) => s + c.totalFreightEur, 0);
      const costEur = unassignedCycles.reduce((s, c) => s + c.totalCostEur, 0);
      const marginEur = unassignedCycles.reduce((s, c) => s + c.marginEur, 0);
      const marginPct = frachtEur > 0 ? (marginEur / frachtEur) * 100 : 0;
      const totalKm = Math.round(unassignedCycles.reduce((s, c) => s + c.totalKm, 0));
      const avgMarginPerCyclePct = unassignedCycles.length > 0
        ? unassignedCycles.reduce((s, c) => s + c.marginPct, 0) / unassignedCycles.length
        : 0;

      list.push({
        id: "__unassigned__",
        name: "⚠ Nieprzypisane",
        vehicles: unassignedVeh.map(v => v.reg),
        ciagniki,
        naczepy,
        cycles: unassignedCycles,
        routesCount: allRoutes.length,
        totalKm,
        frachtEur,
        costEur,
        marginEur,
        marginPct,
        avgMarginPerCyclePct,
        losses: allRoutes.filter(r => r.marginPct < 0).length,
        lowMargin: allRoutes.filter(r => r.marginPct >= 0 && r.marginPct < 5).length,
        breakeven: allRoutes.filter(r => r.marginPct >= 5 && r.marginPct < 15).length,
        profitable: allRoutes.filter(r => r.marginPct >= 15).length,
      });
    }

    return list;
  }, [dispatchers, vehicles, allCycles]);

  // Unique vehicles from cycles
  const vehicleListAll = useMemo(() => {
    const set = new Set(allCycles.map(c => c.vehicleReg));
    return Array.from(set).sort();
  }, [allCycles]);

  // Filtered vehicles based on selected dispatcher
  const vehicleListFiltered = useMemo(() => {
    if (selectedDispatcher === "all") return vehicleListAll;
    const pool = dispatcherPools.find(p => p.id === selectedDispatcher);
    if (!pool) return vehicleListAll;
    // Show vehicles that either are in pool or have cycles matching this dispatcher
    const poolVehs = new Set(pool.vehicles.map(v => v.toUpperCase()));
    return vehicleListAll.filter(v => poolVehs.has(v.toUpperCase()));
  }, [selectedDispatcher, dispatcherPools, vehicleListAll]);

  // Filtered cycles based on selected dispatcher and vehicle
  const filteredCycles = useMemo(() => {
    let list = allCycles;
    if (selectedDispatcher !== "all") {
      const pool = dispatcherPools.find(p => p.id === selectedDispatcher);
      if (pool) {
        const poolVehs = new Set(pool.vehicles.map(v => v.toUpperCase()));
        list = list.filter(c => poolVehs.has(c.vehicleReg.toUpperCase()));
      }
    }
    if (selectedVehicle !== "all") {
      list = list.filter(c => c.vehicleReg === selectedVehicle);
    }
    return list;
  }, [allCycles, selectedDispatcher, selectedVehicle, dispatcherPools]);

  // Toggle expand
  function toggleCycle(key: string) {
    setExpandedCycles(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleExpandAll() {
    if (expandAll) {
      setExpandedCycles(new Set());
      setExpandAll(false);
    } else {
      const all = new Set(filteredCycles.map(c => `${c.vehicleReg}-${c.cycleIndex}`));
      setExpandedCycles(all);
      setExpandAll(true);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        Ładowanie danych pojazdów i dyspozytorów…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-screen-xl mx-auto px-6 py-8">

        {/* Page header */}
        <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Analiza kółek</h1>
            <p className="text-gray-500 text-sm mt-1">
              Cykl od wyjazdu z Polski do powrotu — pełne rozliczenie okresu z podziałem na pule dyspozytorów
            </p>
          </div>

          {/* Upload + options */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowOpts(v => !v)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-100 bg-white shadow-sm"
            >
              ⚙ Opcje
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={parsing}
              className="px-4 py-2 text-sm bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 shadow-sm transition-colors"
            >
              {parsing ? "Analizuję…" : "↑ Wgraj TMS"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xls,.xlsx"
              className="hidden"
              onChange={handleFileUpload}
            />
          </div>
        </div>

        {/* Options panel */}
        {showOpts && <OptionsPanel opts={opts} onChange={setOpts} />}

        {/* Error */}
        {parseError && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 mb-4 text-sm">
            {parseError}
          </div>
        )}

        {/* Empty state */}
        {allCycles.length === 0 && !parsing && (
          <div
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-gray-300 rounded-2xl p-16 flex flex-col items-center justify-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
          >
            <div className="text-5xl mb-4">🔄</div>
            <div className="text-lg font-medium text-gray-700">Wgraj plik TMS</div>
            <div className="text-sm text-gray-400 mt-1">
              Eksport tras z systemu TMS (.xls / .xlsx) — zobaczysz rozliczenie kółek oraz przypisanie do dyspozytorów
            </div>
          </div>
        )}

        {/* Results */}
        {summary && allCycles.length > 0 && (
          <>
            {/* File info */}
            <div className="text-xs text-gray-400 mb-4 flex items-center justify-between flex-wrap gap-2">
              <div>
                {fileName && <span>Plik: <strong>{fileName}</strong> · </span>}
                <span>{rawRoutes.length} tras → {allCycles.length} kółek ({vehicleListAll.length} aktywnych pojazdów)</span>
              </div>
              <div className="text-xs text-slate-500">
                {dispatchers.length} dyspozytorów we flocie
              </div>
            </div>

            {/* Fleet summary KPIs */}
            <FleetSummaryBar summary={summary} />

            {/* ─── Dyspozytorzy — Karty Puli Samochodów (jak w zakładce Dyspozytorzy) ─── */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-gray-800 uppercase tracking-wide">
                    Pule dyspozytorów i wyniki kółek
                  </h2>
                  <span className="text-xs text-gray-400">
                    (kliknij kartę aby przefiltrować kółka danego dyspozytora)
                  </span>
                </div>
                {selectedDispatcher !== "all" && (
                  <button
                    onClick={() => {
                      setSelectedDispatcher("all");
                      setSelectedVehicle("all");
                    }}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-md transition-colors"
                  >
                    ✕ Pokaż wszystkich ({allCycles.length} kółek)
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {dispatcherPools.map(d => {
                  const isSelected = selectedDispatcher === d.id;
                  const hasLosses = d.losses > 0;
                  const activeCyclesInFile = d.cycles.length;

                  return (
                    <div
                      key={d.id}
                      onClick={() => {
                        setSelectedDispatcher(isSelected ? "all" : d.id);
                        setSelectedVehicle("all");
                      }}
                      className={`bg-white rounded-xl border p-4 cursor-pointer transition-all ${
                        isSelected
                          ? "ring-2 ring-blue-500 shadow-md border-blue-500"
                          : "border-gray-200 hover:shadow hover:border-gray-300"
                      } ${
                        hasLosses
                          ? "border-l-4 border-l-red-500"
                          : d.marginPct >= 15
                          ? "border-l-4 border-l-emerald-500"
                          : "border-l-4 border-l-amber-500"
                      }`}
                    >
                      {/* Top row: Name, badges & margin % */}
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <h3 className="font-bold text-slate-800">{d.name}</h3>
                            {isSelected && (
                              <span className="text-[10px] bg-blue-600 text-white font-semibold px-1.5 py-0.5 rounded">
                                Aktywny filtr
                              </span>
                            )}
                          </div>

                          {/* CIĄ / NAC badges */}
                          <div className="flex gap-1 mt-1 flex-wrap items-center">
                            {d.ciagniki.length > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-blue-100 text-blue-700">
                                🚛 {d.ciagniki.length} CIĄ
                              </span>
                            )}
                            {d.naczepy.length > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-slate-100 text-slate-600">
                                🚌 {d.naczepy.length} NAC
                              </span>
                            )}
                            <span className="text-[10px] text-slate-400">
                              {d.routesCount} tras · {activeCyclesInFile} kółek · {d.totalKm.toLocaleString("pl-PL")} km
                            </span>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className={`text-2xl font-black ${marginColor(d.marginPct)}`}>
                            {fmtPct(d.marginPct)}
                          </div>
                          <div className="text-xs text-slate-400">marża</div>
                        </div>
                      </div>

                      {/* 3 stats boxes */}
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                        <div className="bg-slate-50 rounded-lg py-2">
                          <div className="text-sm font-bold text-slate-800">{fmtEur(d.frachtEur)}</div>
                          <div className="text-xs text-slate-400">fracht</div>
                        </div>
                        <div className="bg-slate-50 rounded-lg py-2">
                          <div className={`text-sm font-bold ${marginColor(d.marginPct)}`}>
                            {fmtEur(d.marginEur)}
                          </div>
                          <div className="text-xs text-slate-400">marża EUR</div>
                        </div>
                        <div className="bg-slate-50 rounded-lg py-2">
                          <div className="text-sm font-bold text-slate-800">
                            {d.cycles.length > 0 ? fmtPct(d.avgMarginPerCyclePct) : "—"}
                          </div>
                          <div className="text-xs text-slate-400">śr./kółko</div>
                        </div>
                      </div>

                      {/* Mini bar status badges */}
                      <div className="mt-3 flex gap-1 text-xs flex-wrap items-center">
                        {d.profitable > 0 && (
                          <div className="bg-emerald-500 text-white rounded px-1.5 py-0.5 font-medium">
                            ✓ {d.profitable}
                          </div>
                        )}
                        {d.breakeven > 0 && (
                          <div className="bg-amber-400 text-white rounded px-1.5 py-0.5 font-medium">
                            ~ {d.breakeven}
                          </div>
                        )}
                        {d.lowMargin > 0 && (
                          <div className="bg-orange-400 text-white rounded px-1.5 py-0.5 font-medium">
                            ↓ {d.lowMargin}
                          </div>
                        )}
                        {d.losses > 0 && (
                          <div className="bg-red-600 text-white rounded px-1.5 py-0.5 font-bold">
                            ✗ {d.losses} STRAT
                          </div>
                        )}
                        {d.routesCount === 0 && (
                          <span className="text-[11px] text-slate-400 italic">Brak tras w pliku</span>
                        )}
                      </div>

                      {/* Pula samochodów dyspozytora (chips) */}
                      {d.vehicles.length > 0 && (
                        <div className="mt-3 pt-2.5 border-t border-gray-100">
                          <div className="text-[11px] text-slate-500 font-medium mb-1.5 flex items-center justify-between">
                            <span>Pula samochodów ({d.vehicles.length}):</span>
                            <span className="text-[10px] text-slate-400 font-normal">
                              {d.vehicles.filter(v => vehicleListAll.includes(v)).length} aktywnych w pliku
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {d.vehicles.map(v => {
                              const hasCycles = vehicleListAll.includes(v);
                              return (
                                <span
                                  key={v}
                                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-medium transition-colors ${
                                    hasCycles
                                      ? "bg-blue-50 text-blue-700 border border-blue-200"
                                      : "bg-gray-100 text-gray-400 border border-transparent"
                                  }`}
                                  title={hasCycles ? "Posiada zarejestrowane trasy w pliku TMS" : "Brak tras w bieżącym pliku"}
                                >
                                  {v}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ─── Vehicle filter tabs ─── */}
            <div className="flex items-center gap-2 mb-4 flex-wrap bg-white p-3 rounded-xl border border-gray-200">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide mr-1">
                Pojazd:
              </span>
              <button
                onClick={() => setSelectedVehicle("all")}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  selectedVehicle === "all"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                Wszystkie {selectedDispatcher !== "all" ? "w puli" : ""} ({filteredCycles.length} kółek)
              </button>

              {vehicleListFiltered.map(v => {
                const count = allCycles.filter(c => c.vehicleReg === v).length;
                const dispName = getVehicleDispatcherName(v);
                return (
                  <button
                    key={v}
                    onClick={() => setSelectedVehicle(v)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                      selectedVehicle === v
                        ? "bg-blue-600 text-white shadow-sm"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    <span>{v}</span>
                    <span className={`text-xs px-1.5 py-0.2 rounded-full ${
                      selectedVehicle === v ? "bg-blue-700 text-white" : "bg-gray-200 text-gray-600"
                    }`}>
                      {count}
                    </span>
                    {selectedDispatcher === "all" && dispName !== "Nieprzypisany" && (
                      <span className={`text-[10px] ${selectedVehicle === v ? "text-blue-200" : "text-gray-400"}`}>
                        · {dispName.split(" ")[0]}
                      </span>
                    )}
                  </button>
                );
              })}

              <div className="ml-auto">
                <button
                  onClick={toggleExpandAll}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800 bg-blue-50 px-2.5 py-1.5 rounded-lg transition-colors"
                >
                  {expandAll ? "▲ Zwiń wszystkie" : "▼ Rozwiń wszystkie"}
                </button>
              </div>
            </div>

            {/* ─── Cycles list ─── */}
            <div>
              {selectedVehicle === "all" ? (
                vehicleListFiltered.map(v => {
                  const vCycles = filteredCycles.filter(c => c.vehicleReg === v);
                  if (vCycles.length === 0) return null;

                  const vFreight = vCycles.reduce((s, c) => s + c.totalFreightEur, 0);
                  const vMargin  = vCycles.reduce((s, c) => s + c.marginEur, 0);
                  const vMarginPct = vFreight > 0 ? (vMargin / vFreight) * 100 : 0;
                  const vehData = vehMap.get(v.toUpperCase());
                  const dispName = getVehicleDispatcherName(v);

                  return (
                    <div key={v} className="mb-8">
                      {/* Vehicle Header with Dispatcher Assignment */}
                      <div className="flex items-center justify-between flex-wrap gap-2 mb-3 bg-white p-3 rounded-xl border border-gray-200 shadow-sm">
                        <div className="flex items-center gap-3 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">🚛</span>
                            <h2 className="text-base font-bold text-gray-800 font-mono">{v}</h2>
                            {vehData?.brand && (
                              <span className="text-xs text-gray-500 font-normal">
                                ({vehData.brand} {vehData.model})
                              </span>
                            )}
                          </div>

                          {/* Przypisanie do dyspozytora */}
                          <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                              <span>👤</span>
                              <span>Dyspozytor: {dispName}</span>
                            </span>
                            {vehData?.vehicle_type && (
                              <span className="text-[11px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full capitalize">
                                {vehData.vehicle_type}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="text-xs text-gray-500 flex items-center gap-2">
                          <span>{vCycles.length} kółek</span>
                          <span>·</span>
                          <span>{fmtEur(vFreight)} fracht</span>
                          <span>·</span>
                          <span className={marginTextColor(vMarginPct)}>
                            {fmtPct(vMarginPct)} marża ({fmtEur(vMargin)})
                          </span>
                        </div>
                      </div>

                      {vCycles.map(c => {
                        const key = `${c.vehicleReg}-${c.cycleIndex}`;
                        return (
                          <CycleCard
                            key={key}
                            cycle={c}
                            expanded={expandedCycles.has(key)}
                            onToggle={() => toggleCycle(key)}
                            dispatcherName={dispName}
                          />
                        );
                      })}
                    </div>
                  );
                })
              ) : (
                filteredCycles.map(c => {
                  const key = `${c.vehicleReg}-${c.cycleIndex}`;
                  const dispName = getVehicleDispatcherName(c.vehicleReg);
                  return (
                    <CycleCard
                      key={key}
                      cycle={c}
                      expanded={expandedCycles.has(key)}
                      onToggle={() => toggleCycle(key)}
                      dispatcherName={dispName}
                    />
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
