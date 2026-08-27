"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { useSettings } from "@/lib/settings-context";
import { FLEET } from "@/lib/calculator";
import { parseKartotekaXLS, type ExpenseMap } from "@/lib/expenseParser";
import {
  buildFleetBudget,
  buildActualMap,
  type VehicleRecord,
  type BudgetSettings,
  type VehicleBudget,
  type ActualMap,
  type RouteActual,
  type FleetBudgetResult,
  type MonthSummary,
  DEFAULT_BUDGET_SETTINGS,
} from "@/lib/budgetEngine";

// ── Types ───────────────────────────────────────────────────
type TabId = "ciagniki" | "naczepy" | "martwe" | "plan";

// ── Helpers ─────────────────────────────────────────────────
function eur(n: number, decimals = 0): string {
  return new Intl.NumberFormat("pl-PL", {
    style: "currency", currency: "EUR",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}
function km(n: number): string {
  return new Intl.NumberFormat("pl-PL").format(Math.round(n)) + " km";
}
function pct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function badgeColor(value: number, invert = false): string {
  const isPositive = invert ? value < 0 : value > 0;
  if (Math.abs(value) < 1) return "bg-slate-100 text-slate-600";
  return isPositive
    ? "bg-emerald-50 text-emerald-700"
    : "bg-red-50 text-red-700";
}

/** Parse Excel serial date → "YYYY-MM" */
function serialToYearMonth(v: unknown): string {
  if (v == null || v === "") return "";
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!isNaN(n) && n > 40000) {
    const d = new Date((n - 25569) * 86400 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const s = String(v);
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}`;
  const iso = s.match(/^(\d{4}-\d{2})/);
  if (iso) return iso[1];
  return "";
}

function parseFracht(s: string): number {
  if (!s) return 0;
  const str = String(s).replace(/\s/g, "");
  const m = str.match(/([\d,.]+)([A-Z]{3})?/);
  if (!m) return 0;
  return parseFloat(m[1].replace(",", ".")) || 0;
}

/** Parse TMS Rejestr Transportów XLS → RouteActual[] */
function parseTmsXls(buf: ArrayBuffer, plnEurRate: number): RouteActual[] {
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const all = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as string[][];

  // Find header row
  let hIdx = 1;
  for (let i = 0; i < Math.min(5, all.length); i++) {
    const joined = all[i].join("|").toLowerCase();
    if (joined.includes("ciągnik") || joined.includes("ciagnik") || joined.includes("nr pe")) {
      hIdx = i; break;
    }
  }
  const headers = all[hIdx].map(h => String(h).trim().toLowerCase());
  const dataRows = all.slice(hIdx + 1).filter(r => r.some(c => String(c).trim() !== ""));

  function colIdx(...keys: string[]): number {
    for (const k of keys) {
      const i = headers.findIndex(h => h.includes(k.toLowerCase()));
      if (i >= 0) return i;
    }
    return -1;
  }

  const iDate    = colIdx("data utworzenia", "data utw", "data podjęcia", "data");
  const iKmLad   = colIdx("lad. wg licznika", "km lad", "km ład");
  const iKmPuste = colIdx("puste wg licznika", "km puste", "km pust");
  const iTractor = colIdx("ciągnik", "ciagnik");
  const iFracht  = colIdx("fracht z walutą", "fracht z waluta", "fracht");
  const iCurrency = colIdx("fracht z walutą", "fracht z waluta", "waluta");

  const results: RouteActual[] = [];

  for (const row of dataRows) {
    const reg = String(row[iTractor] ?? "").trim().toUpperCase();
    if (!reg) continue;

    const yearMonth = serialToYearMonth(row[iDate]);
    if (!yearMonth) continue;

    const kmLaden  = parseFloat(String(row[iKmLad]   ?? "0").replace(",", ".")) || 0;
    const kmEmpty  = parseFloat(String(row[iKmPuste] ?? "0").replace(",", ".")) || 0;

    // Fracht — handle PLN
    const frachtRaw    = String(row[iFracht] ?? "").trim();
    const currencyRaw  = iCurrency >= 0 ? String(row[iCurrency] ?? "").toUpperCase() : "";
    let freightEur = parseFracht(frachtRaw);
    // detect if PLN embedded in string
    if (frachtRaw.includes("PLN") || currencyRaw.includes("PLN")) {
      freightEur = freightEur / plnEurRate;
    }

    results.push({ vehicleReg: reg, yearMonth, kmLaden, kmEmpty, freightEur });
  }
  return results;
}

// ── Variance badge ───────────────────────────────────────────
function VarianceBadge({ value, pctVal, invertGood = false }: {
  value: number; pctVal: number; invertGood?: boolean;
}) {
  if (Math.abs(value) < 0.5) return <span className="text-slate-400 text-xs">—</span>;
  const good = invertGood ? value > 0 : value < 0;
  const cls = good ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-mono ${cls}`}>
      {value > 0 ? "+" : ""}{eur(value)} ({pct(pctVal)})
    </span>
  );
}

// ── Budget card for single vehicle ───────────────────────────
function VehicleBudgetCard({ b, showDetails }: { b: VehicleBudget; showDetails: boolean }) {
  const hasActuals = b.actualCostEur > 0 || b.actualRevenueEur > 0;

  return (
    <div className={`rounded-lg border p-4 ${b.isGhostCost ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <span className="font-mono font-bold text-base text-slate-800">{b.registration}</span>
          {b.isGhostCost && (
            <span className="ml-2 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
              MARTWY KOSZT
            </span>
          )}
        </div>
        <span className="text-xs text-slate-400">{b.yearMonth}</span>
      </div>

      {/* Fixed costs */}
      <div className="space-y-1 text-sm mb-3">
        <div className="flex justify-between">
          <span className="text-slate-500">Leasing</span>
          <span className="font-medium">{eur(b.leasingEurMo)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Ubezpieczenie</span>
          <span className="font-medium">{eur(b.insuranceEurMo)}</span>
        </div>
        {showDetails && b.vehicleType === "tractor" && (
          <>
            <div className="flex justify-between text-slate-500 text-xs pt-1 border-t border-slate-100">
              <span>Paliwo ({km(b.kmTarget)})</span>
              <span>{eur(b.fuelEur)}</span>
            </div>
            <div className="flex justify-between text-slate-500 text-xs">
              <span>Myto</span>
              <span>{eur(b.tollEur)}</span>
            </div>
            <div className="flex justify-between text-slate-500 text-xs">
              <span>Kierowca</span>
              <span>{eur(b.driverEur)}</span>
            </div>
            <div className="flex justify-between text-slate-500 text-xs">
              <span>AdBlue + Serwis</span>
              <span>{eur(b.adblueEur + b.serviceEur)}</span>
            </div>
          </>
        )}
        <div className="flex justify-between font-semibold text-slate-800 pt-1 border-t border-slate-200">
          <span>Budżet kosztów</span>
          <span>{eur(b.totalCost)}</span>
        </div>
        {b.vehicleType === "tractor" && (
          <div className="flex justify-between text-blue-700 font-semibold">
            <span>Min. przychód (cel)</span>
            <span>{eur(b.minRevenue)}</span>
          </div>
        )}
        {b.vehicleType === "tractor" && (
          <div className="flex justify-between text-xs text-slate-400">
            <span>Min. fracht/km</span>
            <span>{b.minFreightPerKm.toFixed(2)} EUR/km</span>
          </div>
        )}
      </div>

      {/* Actuals vs budget */}
      {hasActuals && (
        <div className="mt-3 pt-3 border-t border-slate-200 space-y-1">
          <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1">Wykonanie</div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Koszty rzeczywiste</span>
            <span className="font-medium">{eur(b.actualCostEur)}</span>
          </div>
          {b.vehicleType === "tractor" && (
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Przychód rzeczywisty</span>
              <span className="font-medium">{eur(b.actualRevenueEur)}</span>
            </div>
          )}
          {b.actualKm > 0 && (
            <div className="flex justify-between text-xs text-slate-400">
              <span>Km przejechane</span>
              <span>{km(b.actualKm)}</span>
            </div>
          )}
          <div className="flex justify-between text-sm items-center">
            <span className="text-slate-500">Odchylenie kosztów</span>
            <VarianceBadge value={b.variance} pctVal={b.variancePct} />
          </div>
          {b.vehicleType === "tractor" && (
            <div className="flex justify-between text-sm items-center">
              <span className="text-slate-500">Odchylenie przychodu</span>
              <VarianceBadge value={b.revenueVariance} pctVal={b.revenueVariancePct} invertGood />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Month selector ───────────────────────────────────────────
function MonthPicker({ months, selected, onChange }: {
  months: string[];
  selected: string;
  onChange: (m: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <button
        onClick={() => onChange("all")}
        className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
          selected === "all"
            ? "bg-[#1F3864] text-white"
            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
        }`}
      >
        Wszystkie
      </button>
      {months.map(m => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            selected === m
              ? "bg-[#1F3864] text-white"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

// ── Plan vs Wykonanie chart (simple bar representation) ───────
function PlanVsActualTable({ summaries }: { summaries: MonthSummary[] }) {
  if (summaries.length === 0) {
    return <div className="text-center text-slate-400 py-8">Brak danych do wyświetlenia</div>;
  }

  const maxCost = Math.max(...summaries.map(s => Math.max(s.budgetCostEur, s.actualCostEur)));
  const maxRev  = Math.max(...summaries.map(s => Math.max(s.budgetRevenueEur, s.actualRevenueEur)));

  return (
    <div className="space-y-4">
      {summaries.map(s => {
        const costOverrun = s.actualCostEur > 0 && s.actualCostEur > s.budgetCostEur;
        const revShort    = s.actualRevenueEur > 0 && s.actualRevenueEur < s.budgetRevenueEur;

        return (
          <div key={s.yearMonth} className="border border-slate-200 rounded-lg p-4 bg-white">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-800 text-lg">{s.yearMonth}</h3>
              <div className="flex gap-4 text-sm text-slate-500">
                <span>{s.tractorCount} ciągniki</span>
                <span>{s.trailerCount} naczepy</span>
                {s.actualKm > 0 && <span>{km(s.actualKm)} przejechane</span>}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Koszty */}
              <div>
                <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Koszty</div>
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>Budżet</span>
                    <span className="font-medium">{eur(s.budgetCostEur)}</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full"
                      style={{ width: `${Math.min(100, (s.budgetCostEur / maxCost) * 100)}%` }}
                    />
                  </div>
                  {s.actualCostEur > 0 && (
                    <>
                      <div className="flex justify-between text-sm">
                        <span>Wykonanie</span>
                        <span className={`font-medium ${costOverrun ? "text-red-600" : "text-emerald-600"}`}>
                          {eur(s.actualCostEur)}
                        </span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${costOverrun ? "bg-red-400" : "bg-emerald-400"}`}
                          style={{ width: `${Math.min(100, (s.actualCostEur / maxCost) * 100)}%` }}
                        />
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-slate-500">Odchylenie:</span>
                        <VarianceBadge
                          value={s.actualCostEur - s.budgetCostEur}
                          pctVal={s.budgetCostEur > 0 ? ((s.actualCostEur - s.budgetCostEur) / s.budgetCostEur) * 100 : 0}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Przychody */}
              <div>
                <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Przychody (ciągniki)</div>
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>Min. cel</span>
                    <span className="font-medium">{eur(s.budgetRevenueEur)}</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full"
                      style={{ width: `${Math.min(100, (s.budgetRevenueEur / maxRev) * 100)}%` }}
                    />
                  </div>
                  {s.actualRevenueEur > 0 && (
                    <>
                      <div className="flex justify-between text-sm">
                        <span>Wykonanie</span>
                        <span className={`font-medium ${revShort ? "text-red-600" : "text-emerald-600"}`}>
                          {eur(s.actualRevenueEur)}
                        </span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${revShort ? "bg-red-400" : "bg-emerald-400"}`}
                          style={{ width: `${Math.min(100, (s.actualRevenueEur / maxRev) * 100)}%` }}
                        />
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-slate-500">Odchylenie:</span>
                        <VarianceBadge
                          value={s.actualRevenueEur - s.budgetRevenueEur}
                          pctVal={s.budgetRevenueEur > 0 ? ((s.actualRevenueEur - s.budgetRevenueEur) / s.budgetRevenueEur) * 100 : 0}
                          invertGood
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Km progress */}
            {s.budgetKm > 0 && s.actualKm > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Realizacja km</div>
                <div className="flex justify-between text-sm mb-1">
                  <span>{km(s.actualKm)} / {km(s.budgetKm)} docelowo</span>
                  <span className={`font-medium ${s.actualKm >= s.budgetKm ? "text-emerald-600" : "text-amber-600"}`}>
                    {Math.round((s.actualKm / s.budgetKm) * 100)}%
                  </span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${s.actualKm >= s.budgetKm ? "bg-emerald-400" : "bg-amber-400"}`}
                    style={{ width: `${Math.min(100, (s.actualKm / s.budgetKm) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Upload zone ──────────────────────────────────────────────
function UploadZone({ label, filename, onFile, color = "blue" }: {
  label: string; filename?: string; onFile: (f: File) => void; color?: "blue" | "purple";
}) {
  const ref = useRef<HTMLInputElement>(null);
  const accent = color === "purple" ? "border-purple-300 bg-purple-50 hover:bg-purple-100" : "border-blue-300 bg-blue-50 hover:bg-blue-100";
  return (
    <div
      className={`border-2 border-dashed rounded-lg p-4 cursor-pointer transition-colors ${accent}`}
      onClick={() => ref.current?.click()}
    >
      <input
        ref={ref}
        type="file"
        accept=".xls,.xlsx"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
      <div className="text-center">
        <div className="text-2xl mb-1">{filename ? "✅" : "📂"}</div>
        <div className="text-sm font-medium text-slate-700">{label}</div>
        {filename
          ? <div className="text-xs text-slate-500 mt-1">{filename}</div>
          : <div className="text-xs text-slate-400 mt-1">Kliknij aby wybrać plik XLS/XLSX</div>
        }
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main Page Component
// ─────────────────────────────────────────────────────────────
export default function BudzetPage() {
  const { settings } = useSettings();

  // Budget settings (from Supabase + AppSettings)
  const [budgetSettings, setBudgetSettings] = useState<BudgetSettings>(DEFAULT_BUDGET_SETTINGS);

  // Sync from AppSettings when loaded
  useEffect(() => {
    setBudgetSettings(prev => ({
      ...prev,
      fuelPriceEurL:   settings.fuelPriceEurL   ?? prev.fuelPriceEurL,
      avgFuelL100:     settings.avgFuelL100      ?? prev.avgFuelL100,
      adblueRatePct:   settings.adblueRatePct    ?? prev.adblueRatePct,
      driverDailyCost: settings.driverDailyCost  ?? prev.driverDailyCost,
    }));
  }, [settings]);

  // File state
  const [tmsFilename,  setTmsFilename]  = useState("");
  const [karFilename,  setKarFilename]  = useState("");
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [karExcluded,  setKarExcluded]  = useState<{ eur: number; count: number } | null>(null);

  // Budget result
  const [result,  setResult]  = useState<FleetBudgetResult | null>(null);
  const [vehicles, setVehicles] = useState<VehicleRecord[]>([]);

  // UI state
  const [activeTab,    setActiveTab]    = useState<TabId>("ciagniki");
  const [selectedMonth, setSelectedMonth] = useState("all");
  const [showDetails,  setShowDetails]  = useState(false);
  const [sortKey,      setSortKey]      = useState<"reg" | "cost" | "revenue" | "variance">("reg");

  // Stored parsed data
  const [expenseMap,  setExpenseMap]  = useState<ExpenseMap | null>(null);
  const [actualMap,   setActualMap]   = useState<ActualMap | null>(null);
  const [tmsRoutes,   setTmsRoutes]   = useState<RouteActual[]>([]);

  // Load vehicles from Supabase
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("vehicles")
        .select("reg, vehicle_type, leasing_eur_mo, insurance_eur_mo, service_cost_km, year_produced, avg_km_month")
        .order("reg");
      if (data) {
        // Pojazdy podwykonawców pomijamy całkowicie — ich koszty/leasing nie są kosztami floty B&M
        setVehicles(data.filter(v => v.vehicle_type !== "podwykonawca").map(v => ({
          registration:    v.reg,
          vehicle_type:    v.vehicle_type === "naczepa" ? "trailer" : v.vehicle_type === "van" ? "van" : "tractor",
          leasing_eur_mo:  v.leasing_eur_mo  ? Number(v.leasing_eur_mo)  : undefined,
          insurance_eur_mo: v.insurance_eur_mo ? Number(v.insurance_eur_mo) : undefined,
          service_cost_km: v.service_cost_km  ? Number(v.service_cost_km)  : undefined,
          year_produced:   v.year_produced    ? Number(v.year_produced)    : undefined,
          avg_km_month:    v.avg_km_month     ? Number(v.avg_km_month)     : undefined,
        })));
      }
    })();
  }, []);

  // Compute budget when data changes
  const computeBudget = useCallback((
    _expenseMap: ExpenseMap | null,
    _actualMap: ActualMap | null,
    _vehicles: VehicleRecord[],
    _settings: BudgetSettings,
    _tmsRoutes: RouteActual[],
  ) => {
    // Determine months scope: union of expense months + TMS months
    const monthSet = new Set<string>();
    if (_expenseMap) {
      for (const vMap of _expenseMap.values())
        for (const m of vMap.keys()) monthSet.add(m);
    }
    for (const r of _tmsRoutes) monthSet.add(r.yearMonth);

    const months = Array.from(monthSet).sort();
    if (months.length === 0) return;

    const res = buildFleetBudget(
      _vehicles,
      months,
      _settings,
      _expenseMap ?? undefined,
      _actualMap ?? undefined,
    );
    setResult(res);
    setSelectedMonth("all");
  }, []);

  // Handle TMS file
  async function handleTmsFile(file: File) {
    setTmsFilename(file.name);
    setLoading(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const routes = parseTmsXls(buf, settings.plnEurRate ?? 4.25);
      const aMap = buildActualMap(routes);
      setTmsRoutes(routes);
      setActualMap(aMap);
      computeBudget(expenseMap, aMap, vehicles, budgetSettings, routes);
    } catch (e) {
      setError(`Błąd parsowania TMS: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  // Handle Kartoteka file
  async function handleKarFile(file: File) {
    setKarFilename(file.name);
    setLoading(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseKartotekaXLS(buf, settings.plnEurRate ?? 4.25);
      setExpenseMap(parsed.expenseMap);
      setKarExcluded(parsed.excludedCount > 0 ? { eur: parsed.excludedEur, count: parsed.excludedCount } : null);
      computeBudget(parsed.expenseMap, actualMap, vehicles, budgetSettings, tmsRoutes);
    } catch (e) {
      setError(`Błąd parsowania Kartoteki: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  // Re-compute when budget settings change
  function applySettings(updated: Partial<BudgetSettings>) {
    const next = { ...budgetSettings, ...updated };
    setBudgetSettings(next);
    if (vehicles.length > 0) {
      computeBudget(expenseMap, actualMap, vehicles, next, tmsRoutes);
    }
  }

  // Filtered budgets by selected month
  const months = result?.months ?? [];
  const filteredTractors = (result?.tractorBudgets ?? [])
    .filter(b => selectedMonth === "all" || b.yearMonth === selectedMonth);
  const filteredTrailers = (result?.trailerBudgets ?? [])
    .filter(b => selectedMonth === "all" || b.yearMonth === selectedMonth);

  // Per-vehicle aggregation for "all months" view
  function aggregateByVehicle(budgets: VehicleBudget[]): VehicleBudget[] {
    if (selectedMonth !== "all") return budgets;
    const map = new Map<string, VehicleBudget>();
    for (const b of budgets) {
      if (!map.has(b.registration)) {
        map.set(b.registration, { ...b });
      } else {
        const acc = map.get(b.registration)!;
        acc.leasingEurMo     += b.leasingEurMo;
        acc.insuranceEurMo   += b.insuranceEurMo;
        acc.fixedTotal       += b.fixedTotal;
        acc.fuelEur          += b.fuelEur;
        acc.adblueEur        += b.adblueEur;
        acc.tollEur          += b.tollEur;
        acc.serviceEur       += b.serviceEur;
        acc.driverEur        += b.driverEur;
        acc.variableTotal    += b.variableTotal;
        acc.totalCost        += b.totalCost;
        acc.minRevenue       += b.minRevenue;
        acc.actualCostEur    += b.actualCostEur;
        acc.actualRevenueEur += b.actualRevenueEur;
        acc.actualKm         += b.actualKm;
        acc.variance         += b.variance;
        acc.revenueVariance  += b.revenueVariance;
        acc.isGhostCost      = acc.isGhostCost && b.isGhostCost;
        acc.yearMonth        = "Suma";
      }
    }
    return Array.from(map.values());
  }

  function sortBudgets(budgets: VehicleBudget[]): VehicleBudget[] {
    return [...budgets].sort((a, b) => {
      if (sortKey === "reg") return a.registration.localeCompare(b.registration);
      if (sortKey === "cost") return b.totalCost - a.totalCost;
      if (sortKey === "revenue") return b.minRevenue - a.minRevenue;
      if (sortKey === "variance") return b.variance - a.variance;
      return 0;
    });
  }

  const displayedTractors = sortBudgets(aggregateByVehicle(filteredTractors));
  const displayedTrailers = sortBudgets(aggregateByVehicle(filteredTrailers));
  const ghostCosts = result?.ghostCosts ?? [];

  // Summary row
  function sumRow(bs: VehicleBudget[]) {
    return {
      totalCost:    bs.reduce((s, b) => s + b.totalCost, 0),
      minRevenue:   bs.reduce((s, b) => s + b.minRevenue, 0),
      actualCost:   bs.reduce((s, b) => s + b.actualCostEur, 0),
      actualRev:    bs.reduce((s, b) => s + b.actualRevenueEur, 0),
      actualKm:     bs.reduce((s, b) => s + b.actualKm, 0),
      variance:     bs.reduce((s, b) => s + b.variance, 0),
    };
  }

  const tractorSum = sumRow(displayedTractors);
  const trailerSum = sumRow(displayedTrailers);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">📊 Budżet Floty</h1>
          <p className="text-slate-500 text-sm mt-1">
            Budżet miesięczny · Plan vs Wykonanie · Martwe koszty
          </p>
        </div>
        {vehicles.length > 0 && (
          <div className="text-xs text-slate-400 text-right">
            {vehicles.filter(v => v.vehicle_type === "tractor").length} ciągniki ·{" "}
            {vehicles.filter(v => v.vehicle_type === "trailer").length} naczepy z Supabase
          </div>
        )}
      </div>

      {/* Upload + Settings panel */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <h2 className="font-semibold text-slate-700 text-sm uppercase tracking-wide">Wczytaj dane</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UploadZone
            label="Rejestr Transportów (TMS)"
            filename={tmsFilename}
            onFile={handleTmsFile}
            color="blue"
          />
          <UploadZone
            label="Kartoteka Wydatków"
            filename={karFilename}
            onFile={handleKarFile}
            color="purple"
          />
        </div>
        {karExcluded && (
          <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            ⚠ Wykluczono {karExcluded.count} wierszy dostawców nieflotowych ({eur(karExcluded.eur)}) — nie wliczono do kosztów floty
          </div>
        )}

        {/* Budget parameters */}
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-slate-600 hover:text-slate-800 select-none">
            ⚙️ Parametry budżetu
          </summary>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Cel km/mies. (ciągnik)", key: "kmTargetMo" as const, step: 500 },
              { label: "Myto EUR/km", key: "tollEurPerKm" as const, step: 0.01 },
              { label: "Marża docelowa %", key: "budgetMarginPct" as const, step: 1 },
              { label: "Cena paliwa EUR/l", key: "fuelPriceEurL" as const, step: 0.01 },
            ].map(f => (
              <div key={f.key}>
                <label className="block text-xs text-slate-500 mb-1">{f.label}</label>
                <input
                  type="number"
                  step={f.step}
                  value={budgetSettings[f.key]}
                  onChange={e => applySettings({ [f.key]: parseFloat(e.target.value) || 0 })}
                  className="w-full border border-slate-200 rounded px-2 py-1 text-sm font-mono"
                />
              </div>
            ))}
          </div>
        </details>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
            {error}
          </div>
        )}
        {loading && (
          <div className="text-sm text-blue-600 animate-pulse">Przetwarzanie pliku…</div>
        )}
      </div>

      {/* No data state */}
      {!result && !loading && (
        <div className="bg-slate-50 rounded-xl border border-dashed border-slate-200 p-12 text-center">
          <div className="text-4xl mb-3">💰</div>
          <p className="text-slate-500">Wczytaj Rejestr Transportów i/lub Kartotekę Wydatków<br />aby zobaczyć budżet floty</p>
        </div>
      )}

      {result && (
        <>
          {/* Tabs */}
          <div className="border-b border-slate-200">
            <nav className="flex gap-0">
              {([
                { id: "ciagniki", label: `🚛 Ciągniki (${new Set(result.tractorBudgets.map(b => b.registration)).size})` },
                { id: "naczepy",  label: `🔧 Naczepy (${new Set(result.trailerBudgets.map(b => b.registration)).size})` },
                { id: "martwe",   label: `💀 Martwe koszty (${ghostCosts.length})` },
                { id: "plan",     label: "📈 Plan vs Wykonanie" },
              ] as const).map(t => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === t.id
                      ? "border-[#1F3864] text-[#1F3864]"
                      : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Month filter (for ciagniki / naczepy tabs) */}
          {(activeTab === "ciagniki" || activeTab === "naczepy") && months.length > 1 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs text-slate-500 font-medium">Okres:</span>
              <MonthPicker months={months} selected={selectedMonth} onChange={setSelectedMonth} />
              <div className="ml-auto flex gap-2 items-center">
                <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showDetails}
                    onChange={e => setShowDetails(e.target.checked)}
                    className="rounded"
                  />
                  Pokaż szczegóły
                </label>
                <select
                  value={sortKey}
                  onChange={e => setSortKey(e.target.value as typeof sortKey)}
                  className="text-xs border border-slate-200 rounded px-2 py-1"
                >
                  <option value="reg">Sortuj: Rejestracja</option>
                  <option value="cost">Sortuj: Koszty ↓</option>
                  <option value="revenue">Sortuj: Min. przychód ↓</option>
                  <option value="variance">Sortuj: Odchylenie ↓</option>
                </select>
              </div>
            </div>
          )}

          {/* ── Tab: Ciągniki ── */}
          {activeTab === "ciagniki" && (
            <div className="space-y-4">
              {/* Summary row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Budżet kosztów", value: eur(tractorSum.totalCost), color: "text-slate-800" },
                  { label: "Min. przychód", value: eur(tractorSum.minRevenue), color: "text-blue-700" },
                  { label: "Koszty rzeczywiste", value: tractorSum.actualCost > 0 ? eur(tractorSum.actualCost) : "—", color: "text-slate-600" },
                  { label: "Przychód rzeczywisty", value: tractorSum.actualRev > 0 ? eur(tractorSum.actualRev) : "—", color: tractorSum.actualRev >= tractorSum.minRevenue ? "text-emerald-600" : "text-red-600" },
                ].map(s => (
                  <div key={s.label} className="bg-white border border-slate-200 rounded-lg p-3">
                    <div className="text-xs text-slate-400 mb-1">{s.label}</div>
                    <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                  </div>
                ))}
              </div>

              {displayedTractors.length === 0 ? (
                <div className="text-center text-slate-400 py-8">Brak danych ciągników</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {displayedTractors.map(b => (
                    <VehicleBudgetCard key={`${b.registration}-${b.yearMonth}`} b={b} showDetails={showDetails} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Naczepy ── */}
          {activeTab === "naczepy" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { label: "Budżet kosztów (naczepy)", value: eur(trailerSum.totalCost), color: "text-slate-800" },
                  { label: "Koszty rzeczywiste", value: trailerSum.actualCost > 0 ? eur(trailerSum.actualCost) : "—", color: "text-slate-600" },
                  { label: "Odchylenie", value: trailerSum.actualCost > 0 ? eur(trailerSum.variance) : "—", color: trailerSum.variance < 0 ? "text-emerald-600" : "text-red-600" },
                ].map(s => (
                  <div key={s.label} className="bg-white border border-slate-200 rounded-lg p-3">
                    <div className="text-xs text-slate-400 mb-1">{s.label}</div>
                    <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                  </div>
                ))}
              </div>

              {displayedTrailers.length === 0 ? (
                <div className="text-center text-slate-400 py-8">Brak danych naczep</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {displayedTrailers.map(b => (
                    <VehicleBudgetCard key={`${b.registration}-${b.yearMonth}`} b={b} showDetails={showDetails} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Martwe Koszty ── */}
          {activeTab === "martwe" && (
            <div className="space-y-4">
              {ghostCosts.length === 0 ? (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-8 text-center">
                  <div className="text-3xl mb-2">✅</div>
                  <p className="text-emerald-700 font-medium">Brak martwych kosztów</p>
                  <p className="text-emerald-600 text-sm mt-1">
                    Wszystkie pojazdy z kosztami mają zarejestrowane trasy
                  </p>
                </div>
              ) : (
                <>
                  {/* Ghost cost summary */}
                  <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-2xl">💀</span>
                      <div>
                        <div className="font-bold text-red-800">
                          {ghostCosts.length} miesięcy z martwymi kosztami
                        </div>
                        <div className="text-sm text-red-600">
                          Łącznie: {eur(ghostCosts.reduce((s, b) => s + b.actualCostEur, 0))} w miesiącach bez km
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="text-left px-3 py-2 font-semibold text-slate-600">Pojazd</th>
                          <th className="text-left px-3 py-2 font-semibold text-slate-600">Typ</th>
                          <th className="text-left px-3 py-2 font-semibold text-slate-600">Miesiąc</th>
                          <th className="text-right px-3 py-2 font-semibold text-slate-600">Koszty EUR</th>
                          <th className="text-right px-3 py-2 font-semibold text-slate-600">Leasing EUR/mies.</th>
                          <th className="text-right px-3 py-2 font-semibold text-slate-600">Ubezp. EUR/mies.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ghostCosts.map(b => (
                          <tr key={`${b.registration}-${b.yearMonth}`} className="border-b border-slate-100 hover:bg-red-50">
                            <td className="px-3 py-2 font-mono font-bold text-red-700">{b.registration}</td>
                            <td className="px-3 py-2 text-slate-500">
                              {b.vehicleType === "tractor" ? "Ciągnik" : "Naczepa"}
                            </td>
                            <td className="px-3 py-2 text-slate-600">{b.yearMonth}</td>
                            <td className="px-3 py-2 text-right font-medium text-red-700">
                              {eur(b.actualCostEur)}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600">
                              {b.leasingEurMo > 0 ? eur(b.leasingEurMo) : "—"}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600">
                              {b.insuranceEurMo > 0 ? eur(b.insuranceEurMo) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-red-50 border-t-2 border-red-200 font-bold">
                          <td colSpan={3} className="px-3 py-2 text-red-800">SUMA</td>
                          <td className="px-3 py-2 text-right text-red-800">
                            {eur(ghostCosts.reduce((s, b) => s + b.actualCostEur, 0))}
                          </td>
                          <td colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Tab: Plan vs Wykonanie ── */}
          {activeTab === "plan" && (
            <div className="space-y-4">
              {result.summaryByMonth.length === 0 ? (
                <div className="text-center text-slate-400 py-8">Brak danych miesięcznych</div>
              ) : (
                <>
                  {/* Annual summary */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {(() => {
                      const totBudgetCost = result.summaryByMonth.reduce((s, m) => s + m.budgetCostEur, 0);
                      const totBudgetRev  = result.summaryByMonth.reduce((s, m) => s + m.budgetRevenueEur, 0);
                      const totActCost    = result.summaryByMonth.reduce((s, m) => s + m.actualCostEur, 0);
                      const totActRev     = result.summaryByMonth.reduce((s, m) => s + m.actualRevenueEur, 0);
                      return [
                        { label: "Budżet kosztów (suma)", value: eur(totBudgetCost), color: "text-slate-800" },
                        { label: "Min. przychód (suma)", value: eur(totBudgetRev), color: "text-blue-700" },
                        { label: "Koszty rzeczywiste", value: totActCost > 0 ? eur(totActCost) : "—", color: "text-slate-600" },
                        { label: "Przychód rzeczywisty", value: totActRev > 0 ? eur(totActRev) : "—", color: totActRev >= totBudgetRev ? "text-emerald-600" : "text-red-600" },
                      ];
                    })().map(s => (
                      <div key={s.label} className="bg-white border border-slate-200 rounded-lg p-3">
                        <div className="text-xs text-slate-400 mb-1">{s.label}</div>
                        <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                      </div>
                    ))}
                  </div>

                  <PlanVsActualTable summaries={result.summaryByMonth} />
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
