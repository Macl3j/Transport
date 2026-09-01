"use client";

import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/lib/supabase";

interface Vehicle {
  id: string;
  reg: string;
  brand: string | null;
  model: string | null;
  vehicle_type: string | null;
  year_produced: number | null;
  odometer_km: number | null;
  avg_fuel_l100: number | null;
  leasing_eur_mo: number | null;
  leasing_brutto_eur_mo: number | null;
  insurance_eur_mo: number | null;
  service_cost_km: number | null;
  avg_km_month: number | null;
  is_active: boolean;
  service_contract: boolean | null;
  leasing_end_date: string | null;
  buyout_eur: number | null;
}

type SortKey = keyof Pick<Vehicle, "reg" | "brand" | "year_produced" | "odometer_km" | "avg_fuel_l100" | "leasing_eur_mo">;

// Formularz edycji/dodawania — bez id/is_active dla nowego pojazdu (nadawane przez bazę)
type VehicleDraft = Omit<Vehicle, "id" | "is_active"> & { id?: string; is_active?: boolean };

const EMPTY_VEHICLE: VehicleDraft = {
  reg: "", brand: null, model: null, vehicle_type: "ciągnik",
  year_produced: null, odometer_km: null, avg_fuel_l100: null,
  leasing_eur_mo: null, leasing_brutto_eur_mo: null, insurance_eur_mo: null,
  service_cost_km: null, avg_km_month: null,
  service_contract: false, leasing_end_date: null, buyout_eur: null,
};

const fmt = (n: number | null) => n != null ? n.toLocaleString("pl-PL") : "—";

export default function FleetPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState("all");
  const [filterYear, setFilterYear] = useState("all");
  const [filterOdo, setFilterOdo] = useState("all");
  const [filterLeasing, setFilterLeasing] = useState("all");
  const [filterType, setFilterType] = useState("all");

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("reg");
  const [sortDesc, setSortDesc] = useState(false);

  const [editVehicle, setEditVehicle] = useState<VehicleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Active/inactive filter
  const [filterActive, setFilterActive] = useState<"active" | "inactive" | "all">("active");

  useEffect(() => { loadVehicles(); }, []);

  async function loadVehicles() {
    // Load ALL vehicles — no is_active filter here, we filter in UI
    const { data } = await supabase
      .from("vehicles")
      .select("id,reg,brand,model,vehicle_type,year_produced,odometer_km,avg_fuel_l100,leasing_eur_mo,leasing_brutto_eur_mo,insurance_eur_mo,service_cost_km,avg_km_month,is_active,service_contract,leasing_end_date,buyout_eur")
      .order("vehicle_type,reg");
    setVehicles(data ?? []);
    setLoading(false);
  }

  async function toggleActive(v: Vehicle) {
    setTogglingId(v.id);
    await supabase.from("vehicles").update({ is_active: !v.is_active }).eq("id", v.id);
    setTogglingId(null);
    await loadVehicles();
  }

  async function saveVehicle(v: VehicleDraft) {
    setSaving(true);
    setSaveError(null);
    // Netto puste, a brutto wypełnione → wylicz netto (brutto / 1.23),
    // bo cała aplikacja (kalkulator, budżet, koła) czyta leasing_eur_mo
    const netto = v.leasing_eur_mo == null && v.leasing_brutto_eur_mo != null
      ? Math.round(v.leasing_brutto_eur_mo / 1.23 * 100) / 100
      : v.leasing_eur_mo;
    const payload = {
      brand:                v.brand,
      model:                v.model,
      vehicle_type:         v.vehicle_type,
      year_produced:        v.year_produced,
      odometer_km:          v.odometer_km,
      avg_fuel_l100:        v.avg_fuel_l100,
      leasing_eur_mo:       netto,
      leasing_brutto_eur_mo: v.leasing_brutto_eur_mo,
      insurance_eur_mo:     v.insurance_eur_mo,
      service_cost_km:      v.service_cost_km,
      avg_km_month:         v.avg_km_month,
      service_contract:     v.service_contract,
      leasing_end_date:     v.leasing_end_date,
      buyout_eur:           v.buyout_eur,
    };

    if (v.id) {
      const { error } = await supabase.from("vehicles").update(payload).eq("id", v.id);
      if (error) { setSaving(false); setSaveError(error.message); return; }
    } else {
      const reg = v.reg.trim().toUpperCase().replace(/\s+/g, "");
      if (!reg) { setSaving(false); setSaveError("Podaj numer rejestracyjny."); return; }
      const { error } = await supabase.from("vehicles").insert({ ...payload, reg });
      if (error) {
        setSaving(false);
        setSaveError(error.code === "23505" ? `Pojazd o rejestracji "${reg}" już istnieje.` : error.message);
        return;
      }
    }
    setSaving(false);
    setEditVehicle(null);
    await loadVehicles();
  }

  function numField(label: string, field: keyof VehicleDraft, unit = "", step = "1") {
    if (!editVehicle) return null;
    const val = editVehicle[field] as number | null;
    return (
      <label className="block">
        <span className="text-xs text-slate-500">{label}{unit ? ` (${unit})` : ""}</span>
        <input type="number" step={step} value={val ?? ""}
          onChange={e => setEditVehicle({...editVehicle, [field]: e.target.value ? +e.target.value : null})}
          className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
      </label>
    );
  }

  function dateField(label: string, field: keyof VehicleDraft) {
    if (!editVehicle) return null;
    const val = editVehicle[field] as string | null;
    return (
      <label className="block">
        <span className="text-xs text-slate-500">{label}</span>
        <input type="date" value={val ?? ""}
          onChange={e => setEditVehicle({...editVehicle, [field]: e.target.value || null})}
          className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
      </label>
    );
  }

  function txtField(label: string, field: keyof VehicleDraft) {
    if (!editVehicle) return null;
    const val = editVehicle[field] as string | null;
    return (
      <label className="block">
        <span className="text-xs text-slate-500">{label}</span>
        <input type="text" value={val ?? ""}
          onChange={e => setEditVehicle({...editVehicle, [field]: e.target.value || null})}
          className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
      </label>
    );
  }

  const brands = useMemo(() =>
    ["all", ...Array.from(new Set(vehicles.map(v => v.brand ?? "—").filter(Boolean))).sort()],
    [vehicles]);

  const years = useMemo(() =>
    ["all", ...Array.from(new Set(vehicles.map(v => v.year_produced?.toString() ?? "").filter(Boolean))).sort().reverse()],
    [vehicles]);

  const filtered = useMemo(() => {
    let list = [...vehicles];

    // Active / inactive filter
    if (filterActive === "active")   list = list.filter(v => v.is_active);
    if (filterActive === "inactive") list = list.filter(v => !v.is_active);

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(v =>
        v.reg.toLowerCase().includes(q) ||
        (v.brand ?? "").toLowerCase().includes(q) ||
        (v.model ?? "").toLowerCase().includes(q)
      );
    }
    if (filterType !== "all") list = list.filter(v => v.vehicle_type === filterType);
    if (filterBrand !== "all") list = list.filter(v => v.brand === filterBrand);
    if (filterYear !== "all") list = list.filter(v => v.year_produced?.toString() === filterYear);
    if (filterOdo === "critical") list = list.filter(v => (v.odometer_km ?? 0) >= 900_000);
    if (filterOdo === "warn") list = list.filter(v => (v.odometer_km ?? 0) >= 700_000 && (v.odometer_km ?? 0) < 900_000);
    if (filterOdo === "ok") list = list.filter(v => (v.odometer_km ?? 0) < 700_000);
    if (filterLeasing === "yes") list = list.filter(v => v.leasing_eur_mo && v.leasing_eur_mo > 0);
    if (filterLeasing === "no") list = list.filter(v => !v.leasing_eur_mo || v.leasing_eur_mo === 0);

    list.sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (typeof av === "number" && typeof bv === "number") return sortDesc ? bv - av : av - bv;
      return sortDesc
        ? String(bv).localeCompare(String(av), "pl")
        : String(av).localeCompare(String(bv), "pl");
    });

    return list;
  }, [vehicles, search, filterType, filterBrand, filterYear, filterOdo, filterLeasing, sortKey, sortDesc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDesc(d => !d);
    else { setSortKey(key); setSortDesc(false); }
  }

  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k ? <span className="ml-1 text-blue-500">{sortDesc ? "↓" : "↑"}</span> : <span className="ml-1 text-slate-300">↕</span>;

  const odoColor = (km: number | null) => {
    if (!km) return "";
    if (km >= 900_000) return "bg-red-50";
    if (km >= 700_000) return "bg-amber-50";
    return "";
  };

  const odoBadge = (km: number | null) => {
    if (!km) return null;
    if (km >= 900_000) return <span className="ml-1.5 px-1.5 py-0.5 bg-red-100 text-red-700 text-[10px] font-bold rounded">KRYT</span>;
    if (km >= 700_000) return <span className="ml-1.5 px-1.5 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-bold rounded">UWAGA</span>;
    return null;
  };

  const euroClass = (year: number | null) => {
    if (!year) return null;
    const cls = year >= 2014 ? 6 : year >= 2009 ? 5 : year >= 2006 ? 4 : 3;
    const color = cls >= 6 ? "bg-emerald-100 text-emerald-700" : cls === 5 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700";
    return <span className={`ml-1.5 px-1.5 py-0.5 ${color} text-[10px] font-bold rounded`}>E{cls}</span>;
  };

  const resetFilters = () => {
    setSearch(""); setFilterType("all"); setFilterBrand("all"); setFilterYear("all");
    setFilterOdo("all"); setFilterLeasing("all");
    // Don't reset filterActive — user picks that intentionally
  };
  const hasFilters = search || filterType !== "all" || filterBrand !== "all" || filterYear !== "all" || filterOdo !== "all" || filterLeasing !== "all";

  // Stats (always on active vehicles for KPI bar)
  const activeVehicles = vehicles.filter(v => v.is_active);
  const inactiveCount  = vehicles.filter(v => !v.is_active).length;
  const critical    = activeVehicles.filter(v => (v.odometer_km ?? 0) >= 900_000).length;
  const warn        = activeVehicles.filter(v => (v.odometer_km ?? 0) >= 700_000 && (v.odometer_km ?? 0) < 900_000).length;
  const withLeasing = activeVehicles.filter(v => v.leasing_eur_mo && v.leasing_eur_mo > 50).length;
  const avgFuel = activeVehicles.filter(v => v.avg_fuel_l100).length > 0
    ? (activeVehicles.reduce((s, v) => s + (v.avg_fuel_l100 ?? 0), 0) / activeVehicles.filter(v => v.avg_fuel_l100).length).toFixed(1)
    : "—";

  if (loading) return (
    <div className="flex items-center gap-2 text-blue-600 text-sm p-8">
      <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      Ładowanie floty…
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Flota pojazdów</h1>
          <p className="text-slate-500 text-sm mt-1">
            <span className="text-emerald-600 font-medium">{activeVehicles.length} aktywnych</span>
            {inactiveCount > 0 && (
              <span className="text-slate-400"> · <span className="text-slate-500">{inactiveCount} wyłączonych</span></span>
            )}
            <span className="text-slate-400"> · wyświetlono {filtered.length}</span>
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Active / Inactive toggle */}
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
            {(["active", "all", "inactive"] as const).map(opt => (
              <button
                key={opt}
                onClick={() => setFilterActive(opt)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  filterActive === opt
                    ? opt === "inactive"
                      ? "bg-white text-slate-500 shadow-sm"
                      : "bg-white text-slate-800 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {opt === "active" ? `✅ Aktywne (${activeVehicles.length})`
                 : opt === "inactive" ? `⛔ Wyłączone (${inactiveCount})`
                 : `Wszystkie (${vehicles.length})`}
              </button>
            ))}
          </div>
          <button onClick={() => { setSaveError(null); setEditVehicle({ ...EMPTY_VEHICLE }); }}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors">
            + Dodaj pojazd
          </button>
        </div>
      </div>

      {/* KPI mini — klikalne: filtrują tabelę wg przebiegu */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <button type="button" onClick={() => setFilterOdo("all")}
          className={`card py-3 text-left transition-shadow ${filterOdo === "all" ? "ring-2 ring-blue-400" : "hover:shadow-md"}`}>
          <p className="text-xs text-slate-500 uppercase tracking-wide">Łącznie aktywnych</p>
          <p className="text-2xl font-bold text-slate-800 mt-0.5">{activeVehicles.length}</p>
          <p className="text-xs text-slate-400">
            {inactiveCount > 0
              ? <span className="text-slate-500">{inactiveCount} wyłączonych z eksploatacji</span>
              : "wszystkie w eksploatacji"}
          </p>
        </button>
        <button type="button" onClick={() => setFilterOdo(filterOdo === "critical" ? "all" : "critical")}
          className={`card py-3 text-left transition-shadow ${critical > 0 ? "border-l-4 border-red-500" : ""} ${filterOdo === "critical" ? "ring-2 ring-red-400" : "hover:shadow-md"}`}>
          <p className="text-xs text-slate-500 uppercase tracking-wide">Krytyczne &gt;900k km</p>
          <p className={`text-2xl font-bold mt-0.5 ${critical > 0 ? "text-red-600" : "text-slate-800"}`}>{critical}</p>
          <p className="text-xs text-slate-400">wymiana w planie</p>
        </button>
        <button type="button" onClick={() => setFilterOdo(filterOdo === "warn" ? "all" : "warn")}
          className={`card py-3 text-left transition-shadow ${warn > 0 ? "border-l-4 border-amber-500" : ""} ${filterOdo === "warn" ? "ring-2 ring-amber-400" : "hover:shadow-md"}`}>
          <p className="text-xs text-slate-500 uppercase tracking-wide">Uwaga 700–900k km</p>
          <p className={`text-2xl font-bold mt-0.5 ${warn > 0 ? "text-amber-600" : "text-slate-800"}`}>{warn}</p>
          <p className="text-xs text-slate-400">obserwacja</p>
        </button>
        <div className="card py-3">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Śr. spalanie</p>
          <p className="text-2xl font-bold text-slate-800 mt-0.5">{avgFuel} <span className="text-sm font-normal">l/100km</span></p>
          <p className="text-xs text-slate-400">leasing: {withLeasing} pojazdów</p>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="flex flex-wrap gap-3 items-end">
          {/* Search */}
          <div className="flex-1 min-w-[180px]">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">Szukaj</label>
            <input
              type="text"
              placeholder="Rejestracja, marka, model…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Type: ciągnik/naczepa */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">Typ</label>
            <select value={filterType} onChange={e => setFilterType(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
              <option value="all">Wszystkie typy</option>
              <option value="ciągnik">Ciągnik</option>
              <option value="naczepa">Naczepa</option>
              <option value="podwykonawca">Podwykonawca</option>
            </select>
          </div>

          {/* Brand */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">Marka</label>
            <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
              {brands.map(b => <option key={b} value={b}>{b === "all" ? "Wszystkie marki" : b}</option>)}
            </select>
          </div>

          {/* Year */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">Rok prod.</label>
            <select value={filterYear} onChange={e => setFilterYear(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
              {years.map(y => <option key={y} value={y}>{y === "all" ? "Wszystkie lata" : y}</option>)}
            </select>
          </div>

          {/* Odometer */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">Przebieg</label>
            <select value={filterOdo} onChange={e => setFilterOdo(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
              <option value="all">Wszystkie</option>
              <option value="ok">Dobry (&lt;700k km)</option>
              <option value="warn">Uwaga (700–900k km)</option>
              <option value="critical">Krytyczny (&gt;900k km)</option>
            </select>
          </div>

          {/* Leasing */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">Leasing</label>
            <select value={filterLeasing} onChange={e => setFilterLeasing(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
              <option value="all">Wszystkie</option>
              <option value="yes">Z leasingiem</option>
              <option value="no">Bez leasingu</option>
            </select>
          </div>

          {/* Reset */}
          {hasFilters && (
            <button onClick={resetFilters}
              className="px-3 py-2 text-sm text-slate-500 hover:text-slate-800 border border-slate-200 rounded-lg hover:border-slate-400 transition-colors">
              ✕ Resetuj
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase w-12">LP</th>
              {([
                ["reg", "Rejestracja"],
                ["brand", "Marka / Model"],
                ["year_produced", "Rok"],
                ["odometer_km", "Licznik (km)"],
                ["avg_fuel_l100", "Spalanie"],
                ["leasing_eur_mo", "Leasing netto EUR/mc"],
              ] as [SortKey, string][]).map(([key, label]) => (
                <th key={key}
                  onClick={() => toggleSort(key)}
                  className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide cursor-pointer hover:text-slate-800 select-none">
                  {label}<SortIcon k={key} />
                </th>
              ))}
              <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Typ</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Ubezp. EUR/mc</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Umowa serwisowa</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400 uppercase w-20 sticky right-0 bg-slate-50 border-l border-slate-200"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.length === 0 ? (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-slate-400 text-sm">Brak pojazdów spełniających kryteria</td></tr>
            ) : filtered.map((v, i) => {
              const rowBg = !v.is_active ? "bg-slate-50" : (odoColor(v.odometer_km) || "bg-white");
              return (
              <tr key={v.id} className={`transition-colors group ${
                !v.is_active
                  ? "opacity-50 bg-slate-50 hover:bg-slate-100"
                  : `hover:bg-slate-50 ${odoColor(v.odometer_km)}`
              }`}>
                <td className="px-4 py-3 text-center text-slate-400 text-xs font-mono">{i + 1}</td>
                <td className="px-4 py-3 font-mono font-semibold text-slate-800">
                  {v.reg}
                  {!v.is_active && (
                    <span className="ml-2 px-1.5 py-0.5 bg-slate-200 text-slate-500 text-[10px] font-bold rounded uppercase tracking-wide">
                      Wyłączony
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-800">{v.brand ?? "—"}</div>
                  <div className="text-xs text-slate-400">{v.model ?? ""}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-slate-700">{v.year_produced ?? "—"}</span>
                  {euroClass(v.year_produced)}
                </td>
                <td className="px-4 py-3">
                  <span className={`font-medium ${(v.odometer_km ?? 0) >= 900_000 ? "text-red-700" : (v.odometer_km ?? 0) >= 700_000 ? "text-amber-700" : "text-slate-700"}`}>
                    {v.odometer_km ? fmt(v.odometer_km) : "—"}
                  </span>
                  {odoBadge(v.odometer_km)}
                </td>
                <td className="px-4 py-3">
                  {v.avg_fuel_l100
                    ? <span className={`font-medium ${v.avg_fuel_l100 > 32 ? "text-red-600" : v.avg_fuel_l100 > 29 ? "text-amber-600" : "text-emerald-600"}`}>
                        {v.avg_fuel_l100} l/100
                      </span>
                    : <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-3">
                  {v.leasing_eur_mo && v.leasing_eur_mo > 50 ? (
                    <div>
                      <span className="font-medium text-slate-700">{fmt(Math.round(v.leasing_eur_mo))} EUR</span>
                      {v.leasing_brutto_eur_mo && <div className="text-xs text-slate-400">brutto: {fmt(Math.round(v.leasing_brutto_eur_mo))}</div>}
                    </div>
                  ) : v.leasing_brutto_eur_mo && v.leasing_brutto_eur_mo > 50 ? (
                    // Wypełnione tylko brutto — pokaż netto wyliczone (brutto / 1.23)
                    <div>
                      <span className="font-medium text-slate-700">{fmt(Math.round(v.leasing_brutto_eur_mo / 1.23))} EUR</span>
                      <div className="text-xs text-slate-400">brutto: {fmt(Math.round(v.leasing_brutto_eur_mo))} (netto wyliczone)</div>
                    </div>
                  ) : <span className="text-slate-400 text-xs">brak / spłacony</span>}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                    v.vehicle_type === "naczepa" ? "bg-indigo-50 text-indigo-700"
                    : v.vehicle_type === "podwykonawca" ? "bg-amber-50 text-amber-700"
                    : v.vehicle_type === "ciągnik" ? "bg-slate-100 text-slate-600"
                    : "bg-slate-100 text-slate-600"
                  }`}>
                    {v.vehicle_type === "naczepa" ? "Naczepa"
                      : v.vehicle_type === "ciągnik" ? "Ciągnik"
                      : v.vehicle_type === "podwykonawca" ? "Podwykonawca"
                      : "—"}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  {v.insurance_eur_mo && v.insurance_eur_mo > 0
                    ? <span className="text-slate-700 text-sm">{fmt(Math.round(v.insurance_eur_mo))}</span>
                    : <span className="text-slate-400 text-xs">—</span>}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                    v.service_contract ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                  }`}>
                    {v.service_contract ? "Tak" : "Nie"}
                  </span>
                </td>
                {/* Toggle active/inactive */}
                <td className="px-4 py-3 text-center">
                  <button
                    onClick={() => toggleActive(v)}
                    disabled={togglingId === v.id}
                    title={v.is_active ? "Kliknij aby wyłączyć z eksploatacji" : "Kliknij aby przywrócić do eksploatacji"}
                    className={`px-3 py-1 text-xs rounded-lg font-medium transition-colors disabled:opacity-40 ${
                      v.is_active
                        ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                    }`}
                  >
                    {togglingId === v.id ? "…" : v.is_active ? "✓ Aktywny" : "Wyłączony"}
                  </button>
                </td>
                <td className={`px-4 py-3 text-center sticky right-0 border-l border-slate-200 ${rowBg} group-hover:bg-slate-50`}>
                  <button onClick={() => { setSaveError(null); setEditVehicle({...v}); }}
                    className="px-3 py-1 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg font-medium transition-colors">
                    Edytuj
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>

        {filtered.length > 0 && (
          <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50 text-xs text-slate-500 flex gap-6">
            <span>Pojazdów: <strong>{filtered.length}</strong></span>
            {filtered.some(v => v.avg_fuel_l100) && (
              <span>Śr. spalanie: <strong>
                {(filtered.filter(v=>v.avg_fuel_l100).reduce((s,v)=>s+(v.avg_fuel_l100??0),0) / filtered.filter(v=>v.avg_fuel_l100).length).toFixed(1)} l/100
              </strong></span>
            )}
            {filtered.some(v => v.leasing_eur_mo && v.leasing_eur_mo > 50) && (
              <span>Łączny leasing: <strong>
                {fmt(Math.round(filtered.reduce((s,v)=>s+(v.leasing_eur_mo&&v.leasing_eur_mo>50?v.leasing_eur_mo:0),0)))} EUR/mies.
              </strong></span>
            )}
          </div>
        )}
      </div>
      {/* Edit Modal */}
      {editVehicle && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={e => e.target === e.currentTarget && setEditVehicle(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-800">{editVehicle.id ? editVehicle.reg : "Nowy pojazd"}</h2>
                <p className="text-xs text-slate-400">{editVehicle.vehicle_type ?? "pojazd"}</p>
              </div>
              <button onClick={() => setEditVehicle(null)} className="text-slate-400 hover:text-slate-700 text-xl">✕</button>
            </div>

            {saveError && (
              <div className="px-3 py-2 rounded-lg bg-red-50 text-red-700 text-sm border border-red-200">{saveError}</div>
            )}

            <div className="grid grid-cols-2 gap-3">
              {/* Dane podstawowe */}
              <div className="col-span-2 border-t pt-3">
                <p className="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">📋 Dane podstawowe</p>
              </div>
              {!editVehicle.id && (
                <label className="block col-span-2">
                  <span className="text-xs text-slate-500">Nr rejestracyjny *</span>
                  <input type="text" value={editVehicle.reg}
                    onChange={e => setEditVehicle({...editVehicle, reg: e.target.value.toUpperCase()})}
                    placeholder="np. PZ1A234"
                    className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none" />
                </label>
              )}
              <label className="block">
                <span className="text-xs text-slate-500">Typ pojazdu</span>
                <select value={editVehicle.vehicle_type ?? "ciągnik"}
                  onChange={e => setEditVehicle({...editVehicle, vehicle_type: e.target.value})}
                  className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white">
                  <option value="ciągnik">Ciągnik</option>
                  <option value="naczepa">Naczepa</option>
                  <option value="podwykonawca">Podwykonawca</option>
                </select>
              </label>
              {txtField("Marka", "brand")}
              {txtField("Model", "model")}
              {numField("Rok produkcji", "year_produced")}
              {numField("Licznik (km)", "odometer_km")}
              {numField("Śr. spalanie (l/100km)", "avg_fuel_l100", "l/100", "0.01")}
              {numField("Śr. km / miesiąc", "avg_km_month")}

              {/* Koszty */}
              <div className="col-span-2 border-t pt-3">
                <p className="text-xs font-bold text-amber-600 uppercase tracking-wide mb-2">💳 Leasing</p>
              </div>
              {numField("Leasing brutto EUR/mc", "leasing_brutto_eur_mo", "EUR", "0.01")}
              <label className="block">
                <span className="text-xs text-slate-500">Leasing netto EUR/mc <span className="text-slate-400">(brutto/1.23)</span></span>
                <input type="number" step="0.01"
                  value={editVehicle.leasing_eur_mo ?? ""}
                  onChange={e => setEditVehicle({...editVehicle, leasing_eur_mo: e.target.value ? +e.target.value : null})}
                  className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                {editVehicle.leasing_brutto_eur_mo && (
                  <button type="button" onClick={() => setEditVehicle({...editVehicle,
                    leasing_eur_mo: Math.round(editVehicle.leasing_brutto_eur_mo! / 1.23 * 100) / 100})}
                    className="mt-1 text-xs text-blue-600 hover:underline">
                    ← Oblicz z brutto ({Math.round(editVehicle.leasing_brutto_eur_mo / 1.23 * 100) / 100} EUR)
                  </button>
                )}
              </label>
              {dateField("Data końca leasingu", "leasing_end_date")}
              {numField("Kwota wykupu", "buyout_eur", "EUR", "0.01")}

              <div className="col-span-2 border-t pt-3">
                <p className="text-xs font-bold text-indigo-600 uppercase tracking-wide mb-2">🛡️ Ubezpieczenie & Serwis</p>
              </div>
              {numField("OC+AC EUR/mc", "insurance_eur_mo", "EUR", "0.01")}
              <label className="block">
                <span className="text-xs text-slate-500">Serwis EUR/km{editVehicle.service_contract ? " (pokryte umową)" : ""}</span>
                <input type="number" step="0.001"
                  disabled={!!editVehicle.service_contract}
                  value={editVehicle.service_contract ? 0 : (editVehicle.service_cost_km ?? "")}
                  onChange={e => setEditVehicle({...editVehicle, service_cost_km: e.target.value ? +e.target.value : null})}
                  className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-100 disabled:text-slate-400" />
              </label>
              <label className="block">
                <span className="text-xs text-slate-500">Umowa serwisowa</span>
                <div className="mt-1 flex gap-1 bg-slate-100 rounded-lg p-1">
                  <button type="button"
                    onClick={() => setEditVehicle({...editVehicle, service_contract: true, service_cost_km: 0})}
                    className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      editVehicle.service_contract ? "bg-emerald-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"
                    }`}>
                    Tak
                  </button>
                  <button type="button"
                    onClick={() => setEditVehicle({...editVehicle, service_contract: false})}
                    className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      !editVehicle.service_contract ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
                    }`}>
                    Nie
                  </button>
                </div>
              </label>
            </div>

            <div className="flex gap-3 pt-2">
              <button onClick={() => saveVehicle(editVehicle)} disabled={saving || !editVehicle.reg.trim()}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {saving ? "Zapisuję…" : editVehicle.id ? "Zapisz zmiany" : "Dodaj pojazd"}
              </button>
              <button onClick={() => setEditVehicle(null)}
                className="px-6 py-2.5 border border-slate-200 text-slate-600 text-sm rounded-xl hover:border-slate-400 transition-colors">
                Anuluj
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
