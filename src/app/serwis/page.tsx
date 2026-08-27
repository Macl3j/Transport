"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";

interface VehicleInfo {
  reg: string;
  vehicle_type: string;
  brand: string | null;
  year_produced: number | null;
  odometer_km: number | null;
}

interface MaintenanceRow {
  id?: string;
  vehicle_reg: string;
  vehicle_type: string;
  current_km: number | null;
  current_km_updated_at: string | null;
  // Ciągnik only
  last_oil_change_km: number | null;
  oil_change_interval_km: number;
  last_service_km: number | null;
  last_service_date: string | null;
  service_interval_km: number;
  service_interval_months: number;
  // Both
  last_inspection_date: string | null;
  next_inspection_date: string | null;
  last_tire_change_km: number | null;
  tire_interval_km: number;
  // Naczepa — date-based intervals
  brake_check_km: number | null;
  brake_check_interval_km: number;
  last_brake_check_date: string | null;
  brake_check_interval_months: number;
  last_tire_date: string | null;
  tire_interval_months: number;
  notes: string | null;
}

type AlertLevel = "ok" | "warn" | "alert" | "overdue" | "unknown";
type VehicleTab = "ciągnik" | "naczepa" | "all";
type SortKey = "reg" | "km" | "oil" | "service" | "inspection" | "tires" | "brakes" | "urgency";

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr).getTime() - Date.now()) / 86400000);
}
// Next date = last date + N months
function nextDateFromInterval(lastDate: string | null, months: number): number | null {
  if (!lastDate) return null;
  const next = new Date(lastDate);
  next.setMonth(next.getMonth() + months);
  return Math.round((next.getTime() - Date.now()) / 86400000);
}
function nextDateStr(lastDate: string | null, months: number): string | null {
  if (!lastDate) return null;
  const next = new Date(lastDate);
  next.setMonth(next.getMonth() + months);
  return next.toLocaleDateString("pl-PL");
}
function kmRem(lastKm: number | null, interval: number, currentKm: number | null): number | null {
  if (lastKm == null || currentKm == null) return null;
  return lastKm + interval - currentKm;
}
function kmLevel(rem: number | null, warn = 5000, alert = 2000): AlertLevel {
  if (rem == null) return "unknown";
  if (rem < 0) return "overdue";
  if (rem <= alert) return "alert";
  if (rem <= warn) return "warn";
  return "ok";
}
function dayLevel(days: number | null, warn = 30, alert = 14): AlertLevel {
  if (days == null) return "unknown";
  if (days < 0) return "overdue";
  if (days <= alert) return "alert";
  if (days <= warn) return "warn";
  return "ok";
}
const lvlColor: Record<AlertLevel, string> = {
  ok:      "text-emerald-700 bg-emerald-50 border border-emerald-200",
  warn:    "text-amber-700 bg-amber-50 border border-amber-200",
  alert:   "text-red-700 bg-red-50 border border-red-200",
  overdue: "text-white bg-red-600 font-bold",
  unknown: "text-slate-400 bg-slate-50",
};
const rowBorder: Record<AlertLevel, string> = {
  ok: "", warn: "border-l-4 border-amber-400",
  alert: "border-l-4 border-red-400",
  overdue: "border-l-4 border-red-700 bg-red-50/30",
  unknown: "",
};

function Badge({ level, text }: { level: AlertLevel; text: string }) {
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${lvlColor[level]}`}>{text}</span>;
}

function worstLevel(levels: AlertLevel[]): AlertLevel {
  const order: AlertLevel[] = ["ok","unknown","warn","alert","overdue"];
  return levels.reduce((w, l) => order.indexOf(l) > order.indexOf(w) ? l : w, "ok" as AlertLevel);
}

function urgencyScore(r: MaintenanceRow): number {
  const scores: number[] = [];
  const oil  = kmRem(r.last_oil_change_km, r.oil_change_interval_km, r.current_km);
  const srv  = kmRem(r.last_service_km, r.service_interval_km, r.current_km);
  const tire = kmRem(r.last_tire_change_km, r.tire_interval_km, r.current_km);
  const brk  = kmRem(r.brake_check_km, r.brake_check_interval_km, r.current_km);
  const insp = daysUntil(r.next_inspection_date);
  [oil, srv, tire, brk].forEach(v => v != null && scores.push(v / 1000));
  if (insp != null) scores.push(insp / 30);
  return scores.length ? Math.min(...scores) : 9999;
}

/** Wartość liczbowa danej kolumny do sortowania — mniejsza = bardziej pilne. Braki danych trafiają na koniec. */
function sortMetric(r: MaintenanceRow, key: SortKey): number {
  const ciagnik = r.vehicle_type === "ciągnik";
  switch (key) {
    case "km": return r.current_km ?? Infinity;
    case "oil": return kmRem(r.last_oil_change_km, r.oil_change_interval_km, r.current_km) ?? Infinity;
    case "service": return kmRem(r.last_service_km, r.service_interval_km, r.current_km) ?? Infinity;
    case "inspection": return daysUntil(r.next_inspection_date) ?? Infinity;
    case "tires": return ciagnik
      ? kmRem(r.last_tire_change_km, r.tire_interval_km, r.current_km) ?? Infinity
      : nextDateFromInterval(r.last_tire_date, r.tire_interval_months) ?? Infinity;
    case "brakes": return nextDateFromInterval(r.last_brake_check_date, r.brake_check_interval_months) ?? Infinity;
    case "urgency": return urgencyScore(r);
    default: return 0;
  }
}

function fmtKm(v: number | null) { return v != null ? v.toLocaleString("pl-PL") : "—"; }
function fmtRem(rem: number | null) {
  if (rem == null) return "—";
  if (rem < 0) return `−${Math.abs(rem).toLocaleString("pl-PL")} km`;
  return `${rem.toLocaleString("pl-PL")} km`;
}
function fmtDays(d: number | null) {
  if (d == null) return "—";
  if (d < 0) return `−${Math.abs(d)}d`;
  return `${d}d`;
}

const DEFAULT_CIAGNIK: Omit<MaintenanceRow, "vehicle_reg" | "vehicle_type"> = {
  current_km: null, current_km_updated_at: null,
  last_oil_change_km: null, oil_change_interval_km: 40000,
  last_inspection_date: null, next_inspection_date: null,
  last_service_km: null, last_service_date: null,
  service_interval_km: 100000, service_interval_months: 12,
  last_tire_change_km: null, tire_interval_km: 120000,
  brake_check_km: null, brake_check_interval_km: 60000,
  last_brake_check_date: null, brake_check_interval_months: 6,
  last_tire_date: null, tire_interval_months: 12,
  notes: null,
};
const DEFAULT_NACZEPA: Omit<MaintenanceRow, "vehicle_reg" | "vehicle_type"> = {
  current_km: null, current_km_updated_at: null,
  last_oil_change_km: null, oil_change_interval_km: 999999,
  last_inspection_date: null, next_inspection_date: null,
  last_service_km: null, last_service_date: null,
  service_interval_km: 999999, service_interval_months: 99,
  last_tire_change_km: null, tire_interval_km: 150000,
  brake_check_km: null, brake_check_interval_km: 60000,
  last_brake_check_date: null, brake_check_interval_months: 6,
  last_tire_date: null, tire_interval_months: 12,
  notes: null,
};

export default function SerwisPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<MaintenanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<MaintenanceRow | null>(null);
  const [tab, setTab] = useState<VehicleTab>("ciągnik");
  const [alertFilter, setAlertFilter] = useState<"all" | "warn" | "alert" | "overdue">("all");
  const [sortKey, setSortKey] = useState<SortKey>("urgency");
  const [sortDesc, setSortDesc] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const { data: vehicles } = await supabase
      .from("vehicles").select("reg, vehicle_type, brand, year_produced, odometer_km")
      .eq("is_active", true).order("reg");
    const { data: maint } = await supabase.from("maintenance").select("*");
    const maintMap: Record<string, MaintenanceRow> = {};
    for (const m of maint ?? []) maintMap[m.vehicle_reg] = m;

    const merged: MaintenanceRow[] = (vehicles ?? [])
      .filter(v => v.vehicle_type === "ciągnik" || v.vehicle_type === "naczepa")
      .map(v => {
        const saved = maintMap[v.reg];
        const defaults = v.vehicle_type === "naczepa" ? DEFAULT_NACZEPA : DEFAULT_CIAGNIK;
        if (saved) return { ...defaults, ...saved, vehicle_type: v.vehicle_type };
        return {
          vehicle_reg: v.reg,
          vehicle_type: v.vehicle_type ?? "ciągnik",
          ...defaults,
          current_km: v.odometer_km ?? null,
        };
      });

    merged.sort((a, b) => urgencyScore(a) - urgencyScore(b));
    setRows(merged);
    setLoading(false);
  }

  async function handleTrimbleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadMsg(null);
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const all = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" }) as string[][];

      let hIdx = 0;
      for (let i = 0; i < Math.min(10, all.length); i++) {
        const j = all[i].join("|").toLowerCase();
        if ((j.includes("pojazd") || j.includes("vehicle")) && j.includes("przebieg")) { hIdx = i; break; }
      }
      const headers = all[hIdx].map(h => String(h).toLowerCase().trim());
      const regIdx = headers.findIndex(h => h.includes("pojazd") || h.includes("vehicle"));
      const kmIdx  = headers.findIndex(h => h.includes("przebieg"));
      if (regIdx < 0 || kmIdx < 0) {
        setUploadMsg(`Nie znaleziono kolumn. Nagłówki: ${headers.filter(h=>h).slice(0,8).join(", ")}`);
        setUploading(false); return;
      }

      // Strip _T4U / _Tablet suffix, take MAX km per vehicle
      const updates: Record<string, number> = {};
      for (const row of all.slice(hIdx + 1)) {
        const raw = String(row[regIdx] ?? "").trim().toUpperCase()
          .replace(/_(T4U|TABLET|FMS|GPS|TMS|TAB|DEMO)$/i, "");
        const km = Math.round(parseFloat(String(row[kmIdx] ?? "").replace(/\s/g,"").replace(",",".")));
        if (raw && km > 100) updates[raw] = Math.max(updates[raw] ?? 0, km);
      }

      const now = new Date().toISOString();
      let updated = 0;
      for (const [reg, km] of Object.entries(updates)) {
        await supabase.from("maintenance").upsert(
          { vehicle_reg: reg, current_km: km, current_km_updated_at: now, vehicle_type: "ciągnik" },
          { onConflict: "vehicle_reg" }
        );
        await supabase.from("vehicles").update({ odometer_km: km }).eq("reg", reg);
        updated++;
      }
      setUploadMsg(`✓ Zaktualizowano przebieg dla ${updated} ciągników z Trimble`);
      await loadData();
    } catch (err) { setUploadMsg(`Błąd: ${String(err)}`); }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function saveEdit(r: MaintenanceRow) {
    setSaving(r.vehicle_reg);
    await supabase.from("maintenance").upsert(
      { ...r, updated_at: new Date().toISOString() },
      { onConflict: "vehicle_reg" }
    );
    setSaving(null); setEditRow(null);
    await loadData();
  }

  const isCiagnik = (r: MaintenanceRow) => r.vehicle_type === "ciągnik";

  const tabRows = useMemo(() => rows.filter(r =>
    tab === "all" ? true : r.vehicle_type === tab
  ), [rows, tab]);

  const filtered = useMemo(() => {
    if (alertFilter === "all") return tabRows;
    return tabRows.filter(r => {
      const levels = isCiagnik(r)
        ? [kmLevel(kmRem(r.last_oil_change_km, r.oil_change_interval_km, r.current_km)),
           dayLevel(daysUntil(r.next_inspection_date)),
           kmLevel(kmRem(r.last_service_km, r.service_interval_km, r.current_km)),
           kmLevel(kmRem(r.last_tire_change_km, r.tire_interval_km, r.current_km))]
        : [dayLevel(daysUntil(r.next_inspection_date)),
           kmLevel(kmRem(r.last_tire_change_km, r.tire_interval_km, r.current_km)),
           kmLevel(kmRem(r.brake_check_km, r.brake_check_interval_km, r.current_km))];
      if (alertFilter === "overdue") return levels.some(l => l === "overdue");
      if (alertFilter === "alert")   return levels.some(l => l === "overdue" || l === "alert");
      if (alertFilter === "warn")    return levels.some(l => l !== "ok" && l !== "unknown");
      return true;
    });
  }, [tabRows, alertFilter]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      if (sortKey === "reg") {
        const cmp = a.vehicle_reg.localeCompare(b.vehicle_reg, "pl");
        return sortDesc ? -cmp : cmp;
      }
      const av = sortMetric(a, sortKey), bv = sortMetric(b, sortKey);
      return sortDesc ? bv - av : av - bv;
    });
    return list;
  }, [filtered, sortKey, sortDesc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDesc(d => !d);
    else { setSortKey(key); setSortDesc(false); }
  }
  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k ? <span className="ml-1 text-blue-500">{sortDesc ? "↓" : "↑"}</span> : <span className="ml-1 text-slate-300">↕</span>;

  function countByLevel(type: "ciągnik" | "naczepa" | "all", level: "overdue" | "alert" | "warn") {
    const subset = rows.filter(r => type === "all" || r.vehicle_type === type);
    return subset.filter(r => {
      const levels = isCiagnik(r)
        ? [kmLevel(kmRem(r.last_oil_change_km, r.oil_change_interval_km, r.current_km)),
           dayLevel(daysUntil(r.next_inspection_date)),
           kmLevel(kmRem(r.last_service_km, r.service_interval_km, r.current_km)),
           kmLevel(kmRem(r.last_tire_change_km, r.tire_interval_km, r.current_km))]
        : [dayLevel(daysUntil(r.next_inspection_date)),
           kmLevel(kmRem(r.last_tire_change_km, r.tire_interval_km, r.current_km)),
           kmLevel(kmRem(r.brake_check_km, r.brake_check_interval_km, r.current_km))];
      if (level === "overdue") return levels.some(l => l === "overdue");
      if (level === "alert")   return levels.some(l => l === "alert") && !levels.some(l => l === "overdue");
      return levels.some(l => l === "warn") && !levels.some(l => l === "alert" || l === "overdue");
    }).length;
  }

  const ciagnikCount = rows.filter(r => r.vehicle_type === "ciągnik").length;
  const naczepCount  = rows.filter(r => r.vehicle_type === "naczepa").length;

  if (loading) return (
    <div className="flex items-center gap-2 text-blue-600 text-sm p-8">
      <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      Ładowanie danych serwisowych…
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Nadzór serwisowy</h1>
          <p className="text-slate-500 text-sm mt-1">{ciagnikCount} ciągników · {naczepCount} naczep · Alertowanie wg przebiegu i dat</p>
        </div>
        <label className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-colors
          ${uploading ? "bg-slate-200 text-slate-500" : "bg-blue-600 text-white hover:bg-blue-700"}`}>
          <span>⬆ Trimble XLS (ciągniki)</span>
          <input ref={fileRef} type="file" accept=".xls,.xlsx" className="hidden" onChange={handleTrimbleUpload} disabled={uploading} />
        </label>
      </div>

      {uploadMsg && (
        <div className={`px-4 py-3 rounded-lg text-sm border ${uploadMsg.startsWith("✓") ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}`}>
          {uploadMsg}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {([["ciągnik", `🚛 Ciągniki (${ciagnikCount})`], ["naczepa", `🚌 Naczepy (${naczepCount})`], ["all", "Wszystkie"]] as [VehicleTab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
              tab === t ? "border-blue-600 text-blue-600 bg-blue-50" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>

      {/* KPI */}
      <div className="grid grid-cols-3 gap-3">
        {([
          ["overdue", "Przeterminowane", "border-red-700 text-red-700"],
          ["alert",   "Pilne <2000km/<14dni", "border-red-500 text-red-600"],
          ["warn",    "Zbliżające się", "border-amber-500 text-amber-600"],
        ] as [string, string, string][]).map(([level, label, cls]) => (
          <div key={level}
            onClick={() => setAlertFilter(alertFilter === level ? "all" : level as any)}
            className={`card py-3 cursor-pointer border-l-4 ${cls.split(" ")[0]} ${alertFilter === level ? "ring-2 ring-blue-400" : ""}`}>
            <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-bold mt-0.5 ${cls.split(" ")[1]}`}>
              {countByLevel(tab === "all" ? "all" : tab === "ciągnik" ? "ciągnik" : "naczepa", level as any)}
            </p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th onClick={() => toggleSort("reg")}
                className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-800 select-none">
                Pojazd<SortIcon k="reg" />
              </th>
              <th onClick={() => toggleSort("km")}
                className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-800 select-none">
                Przebieg<SortIcon k="km" />
              </th>
              {(tab === "ciągnik" || tab === "all") && <>
                <th onClick={() => toggleSort("oil")}
                  className="text-center px-3 py-3 text-xs font-semibold text-amber-600 uppercase cursor-pointer hover:opacity-70 select-none">
                  🛢 Olej<SortIcon k="oil" />
                </th>
                <th onClick={() => toggleSort("service")}
                  className="text-center px-3 py-3 text-xs font-semibold text-purple-600 uppercase cursor-pointer hover:opacity-70 select-none">
                  🔧 Serwis<SortIcon k="service" />
                </th>
              </>}
              <th onClick={() => toggleSort("inspection")}
                className="text-center px-3 py-3 text-xs font-semibold text-blue-600 uppercase cursor-pointer hover:opacity-70 select-none">
                🔍 Przegląd<SortIcon k="inspection" />
              </th>
              <th onClick={() => toggleSort("tires")}
                className="text-center px-3 py-3 text-xs font-semibold text-slate-600 uppercase cursor-pointer hover:opacity-70 select-none">
                🏎 Opony<SortIcon k="tires" />
              </th>
              {(tab === "naczepa" || tab === "all") &&
                <th onClick={() => toggleSort("brakes")}
                  className="text-center px-3 py-3 text-xs font-semibold text-orange-600 uppercase cursor-pointer hover:opacity-70 select-none">
                  🛑 Hamulce<SortIcon k="brakes" />
                </th>}
              <th className="text-center px-3 py-3 text-xs font-semibold text-slate-400 uppercase">Akcja</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.length === 0 ? (
              <tr><td colSpan={8} className="py-12 text-center text-slate-400 text-sm">Brak pojazdów</td></tr>
            ) : sorted.map(r => {
              const ciagnik = isCiagnik(r);
              // Ciągnik — km based
              const oilRem  = kmRem(r.last_oil_change_km, r.oil_change_interval_km, r.current_km);
              const srvRem  = kmRem(r.last_service_km, r.service_interval_km, r.current_km);
              const tireRemKm = kmRem(r.last_tire_change_km, r.tire_interval_km, r.current_km);
              const inspDays = daysUntil(r.next_inspection_date);
              // Naczepa — date based
              const tireDays = nextDateFromInterval(r.last_tire_date, r.tire_interval_months);
              const brkDays  = nextDateFromInterval(r.last_brake_check_date, r.brake_check_interval_months);
              const allLevels = ciagnik
                ? [kmLevel(oilRem), dayLevel(inspDays), kmLevel(srvRem), kmLevel(tireRemKm)]
                : [dayLevel(inspDays), dayLevel(tireDays), dayLevel(brkDays)];
              const worst = worstLevel(allLevels);
              return (
                <tr key={r.vehicle_reg} className={`hover:bg-slate-50 ${rowBorder[worst]}`}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold text-slate-800">{r.vehicle_reg}</span>
                      <span className={`text-[10px] px-1.5 py-0 rounded font-bold ${ciagnik ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                        {ciagnik ? "CIĄ" : "NAC"}
                      </span>
                    </div>
                    {r.notes && <div className="text-xs text-slate-400 truncate max-w-[110px]">{r.notes}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="font-medium text-slate-700 text-sm">{fmtKm(r.current_km)}</div>
                    {r.current_km_updated_at && (
                      <div className="text-xs text-slate-400">{new Date(r.current_km_updated_at).toLocaleDateString("pl-PL")}</div>
                    )}
                  </td>
                  {(tab === "ciągnik" || tab === "all") && <>
                    <td className="px-3 py-2.5 text-center">
                      {ciagnik ? <>
                        <Badge level={kmLevel(oilRem)} text={fmtRem(oilRem)} />
                        {r.last_oil_change_km && <div className="text-xs text-slate-400 mt-0.5">{fmtKm(r.last_oil_change_km)} km</div>}
                      </> : <span className="text-slate-300 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {ciagnik ? <>
                        <Badge level={kmLevel(srvRem)} text={fmtRem(srvRem)} />
                        {r.last_service_km && <div className="text-xs text-slate-400 mt-0.5">{fmtKm(r.last_service_km)} km</div>}
                      </> : <span className="text-slate-300 text-xs">—</span>}
                    </td>
                  </>}
                  <td className="px-3 py-2.5 text-center">
                    <Badge level={dayLevel(inspDays)} text={fmtDays(inspDays)} />
                    {r.next_inspection_date && (
                      <div className="text-xs text-slate-400 mt-0.5">
                        {new Date(r.next_inspection_date).toLocaleDateString("pl-PL")}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {ciagnik ? <>
                      <Badge level={kmLevel(tireRemKm)} text={fmtRem(tireRemKm)} />
                      {r.last_tire_change_km && <div className="text-xs text-slate-400 mt-0.5">{fmtKm(r.last_tire_change_km)} km</div>}
                    </> : <>
                      <Badge level={dayLevel(tireDays)} text={fmtDays(tireDays)} />
                      {r.last_tire_date && <div className="text-xs text-slate-400 mt-0.5">{nextDateStr(r.last_tire_date, r.tire_interval_months)}</div>}
                    </>}
                  </td>
                  {(tab === "naczepa" || tab === "all") && (
                    <td className="px-3 py-2.5 text-center">
                      {!ciagnik ? <>
                        <Badge level={dayLevel(brkDays)} text={fmtDays(brkDays)} />
                        {r.last_brake_check_date && <div className="text-xs text-slate-400 mt-0.5">{nextDateStr(r.last_brake_check_date, r.brake_check_interval_months)}</div>}
                      </> : <span className="text-slate-300 text-xs">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-center">
                    <button onClick={() => setEditRow({...r})}
                      className="px-3 py-1 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg font-medium transition-colors">
                      Edytuj
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-4 py-2 border-t border-slate-100 bg-slate-50 text-xs text-slate-500 flex items-center justify-between">
          <span>Wyświetlono: {sorted.length} z {tabRows.length} pojazdów</span>
          {(sortKey !== "urgency" || sortDesc) && (
            <button onClick={() => { setSortKey("urgency"); setSortDesc(false); }}
              className="text-blue-600 hover:underline">
              ↺ Sortuj wg pilności (domyślnie)
            </button>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      {editRow && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={e => e.target === e.currentTarget && setEditRow(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-800">
                {editRow.vehicle_reg}
                <span className={`ml-2 text-xs px-2 py-0.5 rounded font-bold ${isCiagnik(editRow) ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                  {isCiagnik(editRow) ? "Ciągnik" : "Naczepa"}
                </span>
              </h2>
              <button onClick={() => setEditRow(null)} className="text-slate-400 hover:text-slate-700 text-xl">✕</button>
            </div>

            {/* Current km (manual for naczepy) */}
            <div className="border rounded-lg p-3 bg-slate-50">
              <p className="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">
                {isCiagnik(editRow) ? "Aktualny przebieg (z Trimble)" : "Aktualny przebieg (ręcznie)"}
              </p>
              <input type="number" value={editRow.current_km ?? ""}
                onChange={e => setEditRow({...editRow, current_km: e.target.value ? +e.target.value : null})}
                placeholder="km odczytu licznika"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Inspection — both types */}
              <div className="col-span-2 border-t pt-3">
                <p className="text-xs font-bold text-blue-600 uppercase tracking-wide mb-2">🔍 Przegląd techniczny</p>
              </div>
              <label className="block">
                <span className="text-xs text-slate-500">Data ostatniego</span>
                <input type="date" value={editRow.last_inspection_date ?? ""}
                  onChange={e => setEditRow({...editRow, last_inspection_date: e.target.value || null})}
                  className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              </label>
              <label className="block">
                <span className="text-xs text-slate-500">Data następnego</span>
                <input type="date" value={editRow.next_inspection_date ?? ""}
                  onChange={e => setEditRow({...editRow, next_inspection_date: e.target.value || null})}
                  className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              </label>

              {/* Tires — both */}
              <div className="col-span-2 border-t pt-3">
                <p className="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">🏎 Opony</p>
              </div>
              <label className="block">
                <span className="text-xs text-slate-500">Ostatnia zmiana (km)</span>
                <input type="number" value={editRow.last_tire_change_km ?? ""}
                  onChange={e => setEditRow({...editRow, last_tire_change_km: e.target.value ? +e.target.value : null})}
                  className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              </label>
              <label className="block">
                <span className="text-xs text-slate-500">Interwał (km)</span>
                <input type="number" value={editRow.tire_interval_km}
                  onChange={e => setEditRow({...editRow, tire_interval_km: +e.target.value})}
                  className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              </label>

              {/* Oil + Service — ciągnik only */}
              {isCiagnik(editRow) && <>
                <div className="col-span-2 border-t pt-3">
                  <p className="text-xs font-bold text-amber-600 uppercase tracking-wide mb-2">🛢 Wymiana oleju</p>
                </div>
                <label className="block">
                  <span className="text-xs text-slate-500">Ostatnia wymiana (km)</span>
                  <input type="number" value={editRow.last_oil_change_km ?? ""}
                    onChange={e => setEditRow({...editRow, last_oil_change_km: e.target.value ? +e.target.value : null})}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500">Interwał (km)</span>
                  <input type="number" value={editRow.oil_change_interval_km}
                    onChange={e => setEditRow({...editRow, oil_change_interval_km: +e.target.value})}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>

                <div className="col-span-2 border-t pt-3">
                  <p className="text-xs font-bold text-purple-600 uppercase tracking-wide mb-2">🔧 Serwis planowy</p>
                </div>
                <label className="block">
                  <span className="text-xs text-slate-500">Ostatni serwis (km)</span>
                  <input type="number" value={editRow.last_service_km ?? ""}
                    onChange={e => setEditRow({...editRow, last_service_km: e.target.value ? +e.target.value : null})}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500">Data ostatniego serwisu</span>
                  <input type="date" value={editRow.last_service_date ?? ""}
                    onChange={e => setEditRow({...editRow, last_service_date: e.target.value || null})}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500">Interwał km</span>
                  <input type="number" value={editRow.service_interval_km}
                    onChange={e => setEditRow({...editRow, service_interval_km: +e.target.value})}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500">Interwał mies.</span>
                  <input type="number" value={editRow.service_interval_months}
                    onChange={e => setEditRow({...editRow, service_interval_months: +e.target.value})}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>
              </>}

              {/* Naczepa — date-based opony + hamulce */}
              {!isCiagnik(editRow) && <>
                <div className="col-span-2 border-t pt-3">
                  <p className="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">🏎 Opony naczepy (datowo)</p>
                </div>
                <label className="block">
                  <span className="text-xs text-slate-500">Data ostatniej wymiany</span>
                  <input type="date" value={editRow.last_tire_date ?? ""}
                    onChange={e => setEditRow({...editRow, last_tire_date: e.target.value || null})}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500">Interwał (miesiące)</span>
                  <input type="number" value={editRow.tire_interval_months}
                    onChange={e => setEditRow({...editRow, tire_interval_months: +e.target.value})}
                    placeholder="12"
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>

                <div className="col-span-2 border-t pt-3">
                  <p className="text-xs font-bold text-orange-600 uppercase tracking-wide mb-2">🛑 Kontrola hamulców (datowo)</p>
                </div>
                <label className="block">
                  <span className="text-xs text-slate-500">Data ostatniej kontroli</span>
                  <input type="date" value={editRow.last_brake_check_date ?? ""}
                    onChange={e => setEditRow({...editRow, last_brake_check_date: e.target.value || null})}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500">Interwał (miesiące)</span>
                  <input type="number" value={editRow.brake_check_interval_months}
                    onChange={e => setEditRow({...editRow, brake_check_interval_months: +e.target.value})}
                    placeholder="6"
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>
              </>}

              <div className="col-span-2 border-t pt-3">
                <label className="block">
                  <span className="text-xs text-slate-500">Notatki</span>
                  <textarea value={editRow.notes ?? ""} rows={2}
                    onChange={e => setEditRow({...editRow, notes: e.target.value || null})}
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none" />
                </label>
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <button onClick={() => saveEdit(editRow)} disabled={!!saving}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {saving === editRow.vehicle_reg ? "Zapisuję…" : "Zapisz"}
              </button>
              <button onClick={() => setEditRow(null)}
                className="px-6 py-2.5 border border-slate-200 text-slate-600 text-sm rounded-lg hover:border-slate-400 transition-colors">
                Anuluj
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
