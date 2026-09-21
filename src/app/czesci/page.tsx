"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { AuthSession as Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

// ── Typy ─────────────────────────────────────────────────────
type JobStatus = "planowana" | "w_toku" | "zakonczona";
type Ownership = "nieznany" | "leasing_aktywny" | "wykupiony" | "wlasny";
type PartStatus = "do_zdemontowania" | "na_magazynie" | "wystawiona" | "zarezerwowana" | "sprzedana" | "zlomowana";
type Category = "silnik" | "skrzynia" | "most" | "kabina" | "kola_opony" | "elektronika" | "caly_pojazd" | "reszta";

interface Job {
  id: string;
  vehicle_reg: string;
  status: JobStatus;
  ownership_status: Ownership;
  planned_date: string | null;
  done_date: string | null;
  supervisor: string | null;
  estimated_value_pln: number | null;
  notes: string | null;
}
interface Part {
  id: string;
  vehicle_reg: string;
  category: Category;
  name: string;
  spec: string | null;
  asking_price_pln: number | null;
  min_price_pln: number | null;
  status: PartStatus;
  location: string | null;
  notes: string | null;
}
interface Sale {
  id: string;
  part_id: string;
  buyer: string | null;
  sale_price_pln: number;
  sale_date: string;
  invoice_no: string | null;
  payment_status: string | null;
}
interface VehicleLite {
  reg: string;
  brand: string | null;
  model: string | null;
  vehicle_type: string;
  is_active: boolean;
  status_reason: string | null;
  leasing_eur_mo: number | null;
  leasing_end_date: string | null;
  buyout_eur: number | null;
}

const JOB_LABELS: Record<JobStatus, string> = { planowana: "Planowana", w_toku: "W toku", zakonczona: "Zakończona" };
const JOB_COLORS: Record<JobStatus, string> = {
  planowana: "bg-slate-100 text-slate-600", w_toku: "bg-amber-100 text-amber-700", zakonczona: "bg-emerald-100 text-emerald-700",
};
const OWNERSHIP_LABELS: Record<Ownership, string> = {
  nieznany: "Nieznany", leasing_aktywny: "Leasing aktywny", wykupiony: "Wykupiony", wlasny: "Własny",
};
const PART_LABELS: Record<PartStatus, string> = {
  do_zdemontowania: "Do zdemontowania", na_magazynie: "Na magazynie", wystawiona: "Wystawiona",
  zarezerwowana: "Zarezerwowana", sprzedana: "Sprzedana", zlomowana: "Złomowana",
};
const PART_COLORS: Record<PartStatus, string> = {
  do_zdemontowania: "bg-slate-100 text-slate-600", na_magazynie: "bg-blue-100 text-blue-700",
  wystawiona: "bg-amber-100 text-amber-700", zarezerwowana: "bg-purple-100 text-purple-700",
  sprzedana: "bg-emerald-100 text-emerald-700", zlomowana: "bg-red-100 text-red-600",
};
// Statusy oznaczające, że część jest oferowana/rezerwowana — wymagają potwierdzonej własności pojazdu
const SALE_STATUSES: PartStatus[] = ["wystawiona", "zarezerwowana"];
const CATEGORY_LABELS: Record<Category, string> = {
  silnik: "Silnik", skrzynia: "Skrzynia biegów", most: "Most / oś", kabina: "Kabina",
  kola_opony: "Koła i opony", elektronika: "Elektronika", caly_pojazd: "Cały pojazd", reszta: "Reszta",
};

const isOwned = (o: Ownership) => o === "wykupiony" || o === "wlasny";
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtPLN = (n: number) => Math.round(n).toLocaleString("pl-PL") + " PLN";
const num = (s: string) => { const n = parseFloat(s.replace(",", ".")); return isNaN(n) ? null : n; };

// ══════════════════════════════════════════════════════════════
// BRAMKA LOGOWANIA — ten sam model dostępu co CRM i /windykacja
// ══════════════════════════════════════════════════════════════
export default function CzesciPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checking) return <div className="p-8 text-sm text-slate-400">Sprawdzam sesję…</div>;
  if (!session) return <LoginScreen />;
  return <CzesciDashboard session={session} />;
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) setErr(error.message);
  }
  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <div className="card w-full max-w-sm">
        <h1 className="text-lg font-bold text-slate-900 mb-1">Części z wycofanych pojazdów</h1>
        <p className="text-sm text-slate-500 mb-4">Dostęp tylko dla zalogowanych (ten sam login co CRM handlowy).</p>
        <form className="space-y-3" onSubmit={handleLogin}>
          <div><label className="label">Email</label>
            <input className="input-field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div><label className="label">Hasło</label>
            <input className="input-field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button type="submit" className="btn-primary w-full" disabled={loading}>{loading ? "Loguję…" : "Zaloguj"}</button>
        </form>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
function CzesciDashboard({ session }: { session: Session }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [vehicles, setVehicles] = useState<VehicleLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"pojazdy" | "czesci">("pojazdy");
  const [selectedReg, setSelectedReg] = useState<string | null>(null);
  const [addReg, setAddReg] = useState("");
  const [partFilter, setPartFilter] = useState<"all" | PartStatus>("all");
  const [search, setSearch] = useState("");
  const [addSearch, setAddSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [j, p, s, v] = await Promise.all([
      supabase.from("dismantle_jobs").select("*").order("created_at", { ascending: false }),
      supabase.from("vehicle_parts").select("*").order("created_at", { ascending: false }),
      supabase.from("part_sales").select("*"),
      supabase.from("vehicles").select("reg,brand,model,vehicle_type,is_active,status_reason,leasing_eur_mo,leasing_end_date,buyout_eur"),
    ]);
    const err = j.error ?? p.error ?? s.error;
    if (err) {
      setLoadError(err.message.includes("schema cache") || err.message.includes("does not exist")
        ? "Brak tabel modułu — uruchom migrację 022_vehicle_parts.sql w Supabase Studio."
        : err.message);
    } else setLoadError(null);
    setJobs((j.data ?? []) as Job[]);
    setParts((p.data ?? []) as Part[]);
    setSales((s.data ?? []) as Sale[]);
    setVehicles((v.data ?? []) as VehicleLite[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const vehMap = useMemo(() => new Map(vehicles.map((v) => [v.reg, v])), [vehicles]);
  const saleByPart = useMemo(() => new Map(sales.map((s) => [s.part_id, s])), [sales]);

  const revenue = sales.reduce((s, x) => s + Number(x.sale_price_pln || 0), 0);
  const stockValue = parts
    .filter((p) => p.status !== "sprzedana" && p.status !== "zlomowana")
    .reduce((s, p) => s + Number(p.asking_price_pln || 0), 0);
  const activeJobs = jobs.filter((j) => j.status !== "zakonczona").length;

  // Wyszukiwanie ignoruje wielkość liter, spacje i myślniki w numerze rejestracyjnym
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[\s-]/g, "");
  const vehicleMatches = (reg: string, q: string) => {
    const nq = norm(q);
    if (!nq) return true;
    const v = vehMap.get(reg);
    return [reg, v?.brand, v?.model, v?.vehicle_type].some((f) => norm(f).includes(nq));
  };

  const candidates = vehicles
    .filter((v) => !jobs.some((j) => j.vehicle_reg === v.reg))
    .filter((v) => vehicleMatches(v.reg, addSearch))
    .sort((a, b) => Number(a.is_active) - Number(b.is_active) || a.reg.localeCompare(b.reg));

  async function addJob() {
    if (!addReg) return;
    const { data, error } = await supabase
      .from("dismantle_jobs").insert({ vehicle_reg: addReg, created_by: session.user.id }).select("vehicle_reg").single();
    if (!error && data) { setAddReg(""); await load(); setSelectedReg(data.vehicle_reg); }
  }

  const selectedJob = jobs.find((j) => j.vehicle_reg === selectedReg) ?? null;
  const filteredJobs = jobs.filter((j) => vehicleMatches(j.vehicle_reg, search));
  const filteredParts = parts.filter((p) =>
    (partFilter === "all" || p.status === partFilter) &&
    (vehicleMatches(p.vehicle_reg, search) || norm(p.name).includes(norm(search)) || norm(p.spec).includes(norm(search))));

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Części z wycofanych pojazdów</h1>
          <p className="text-slate-500 text-sm mt-1">
            {activeJobs} pojazdów w rozbiórce · {parts.length} części · na stanie {fmtPLN(stockValue)} (ceny wywoławcze)
            · sprzedane za <span className="text-emerald-600 font-medium">{fmtPLN(revenue)}</span>
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-500">{session.user.email}</span>
          <button className="text-slate-400 hover:text-slate-700" onClick={() => supabase.auth.signOut()}>Wyloguj</button>
        </div>
      </div>

      {loadError && <div className="card text-sm text-red-600">{loadError}</div>}

      <div className="flex gap-1 border-b border-slate-200">
        {(["pojazdy", "czesci"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === t ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {t === "pojazdy" ? "Pojazdy" : "Wszystkie części"}
          </button>
        ))}
      </div>

      {tab === "pojazdy" ? (
        <div className="flex gap-5 flex-wrap items-start">
          <div className="flex-1 min-w-[320px] space-y-3">
            <div className="card p-3 flex gap-2 items-end">
              <div className="flex-1">
                <label className="label">Dodaj pojazd do rozbiórki / sprzedaży</label>
                <input className="input-field mb-1.5" placeholder="Szukaj w flocie: nr rej., marka, model…"
                  value={addSearch} onChange={(e) => { setAddSearch(e.target.value); setAddReg(""); }} />
                <select className="input-field bg-white" value={addReg} onChange={(e) => setAddReg(e.target.value)}>
                  <option value="">— {candidates.length === 0 ? "brak pasujących pojazdów" : `wybierz pojazd (${candidates.length}, nieaktywne na górze)`} —</option>
                  {candidates.map((v) => (
                    <option key={v.reg} value={v.reg}>
                      {v.reg} · {[v.brand, v.model].filter(Boolean).join(" ") || v.vehicle_type}{v.is_active ? "" : " · nieaktywny"}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn-primary" disabled={!addReg} onClick={addJob}>+ Dodaj</button>
            </div>

            <div className="card p-0 overflow-hidden">
              <div className="p-3 border-b border-slate-100">
                <input className="input-field" placeholder="Szukaj pojazdu w rozbiórce: nr rej., marka, model…"
                  value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {loading ? <div className="p-6 text-sm text-slate-400">Ładowanie…</div>
                : jobs.length === 0 ? <div className="p-6 text-sm text-slate-400 text-center">Brak pojazdów w rozbiórce</div>
                : filteredJobs.length === 0 ? <div className="p-6 text-sm text-slate-400 text-center">Brak pojazdów pasujących do „{search}”</div>
                : (
                <div className="divide-y divide-slate-100 max-h-[65vh] overflow-y-auto">
                  {filteredJobs.map((j) => {
                    const v = vehMap.get(j.vehicle_reg);
                    const jp = parts.filter((p) => p.vehicle_reg === j.vehicle_reg);
                    const sold = jp.reduce((s, p) => s + Number(saleByPart.get(p.id)?.sale_price_pln ?? 0), 0);
                    return (
                      <button key={j.id} onClick={() => setSelectedReg(j.vehicle_reg)}
                        className={`w-full text-left px-4 py-3 hover:bg-slate-50 ${selectedReg === j.vehicle_reg ? "bg-blue-50" : ""}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-semibold text-slate-800 text-sm">{j.vehicle_reg}
                            <span className="font-sans font-normal text-slate-500 ml-2">{[v?.brand, v?.model].filter(Boolean).join(" ")}</span>
                          </span>
                          <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${JOB_COLORS[j.status]}`}>{JOB_LABELS[j.status]}</span>
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
                          <span>{jp.length} części</span>
                          <span>sprzedano {fmtPLN(sold)}</span>
                          {j.estimated_value_pln != null && <span>kosztorys {fmtPLN(Number(j.estimated_value_pln))}</span>}
                          {!isOwned(j.ownership_status) && <span className="text-red-600 font-medium">⚠ własność: {OWNERSHIP_LABELS[j.ownership_status]}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {selectedJob && (
            <div className="flex-1 min-w-[380px]">
              <JobDetail
                key={selectedJob.id}
                job={selectedJob}
                vehicle={vehMap.get(selectedJob.vehicle_reg) ?? null}
                parts={parts.filter((p) => p.vehicle_reg === selectedJob.vehicle_reg)}
                saleByPart={saleByPart}
                session={session}
                onClose={() => setSelectedReg(null)}
                onChanged={load}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <input className="input-field max-w-md" placeholder="Szukaj części: nr rej., marka, nazwa, specyfikacja…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="flex gap-1.5 flex-wrap">
            {(["all", ...Object.keys(PART_LABELS)] as ("all" | PartStatus)[]).map((s) => (
              <button key={s} onClick={() => setPartFilter(s)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${partFilter === s ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {s === "all" ? "Wszystkie" : PART_LABELS[s]} ({s === "all" ? parts.length : parts.filter((p) => p.status === s).length})
              </button>
            ))}
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b">
                <tr className="text-left text-xs text-slate-500 uppercase">
                  <th className="px-4 py-2">Pojazd</th><th className="px-4 py-2">Część</th><th className="px-4 py-2">Kategoria</th>
                  <th className="px-4 py-2">Lokalizacja</th><th className="px-4 py-2 text-right">Cena</th><th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredParts.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">Brak części</td></tr>}
                {filteredParts.map((p) => {
                  const sale = saleByPart.get(p.id);
                  return (
                    <tr key={p.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => { setTab("pojazdy"); setSelectedReg(p.vehicle_reg); }}>
                      <td className="px-4 py-2 font-mono text-xs font-semibold">{p.vehicle_reg}</td>
                      <td className="px-4 py-2">{p.name}{p.spec && <div className="text-xs text-slate-400">{p.spec}</div>}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{CATEGORY_LABELS[p.category]}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{p.location ?? "—"}</td>
                      <td className="px-4 py-2 text-right text-xs">{sale ? fmtPLN(Number(sale.sale_price_pln)) : p.asking_price_pln != null ? fmtPLN(Number(p.asking_price_pln)) : "—"}</td>
                      <td className="px-4 py-2"><span className={`text-xs px-2 py-0.5 rounded-full ${PART_COLORS[p.status]}`}>{PART_LABELS[p.status]}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SZCZEGÓŁY POJAZDU W ROZBIÓRCE
// ══════════════════════════════════════════════════════════════
function JobDetail({
  job, vehicle, parts, saleByPart, session, onClose, onChanged,
}: {
  job: Job; vehicle: VehicleLite | null; parts: Part[]; saleByPart: Map<string, Sale>;
  session: Session; onClose: () => void; onChanged: () => void;
}) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({
    status: job.status, ownership_status: job.ownership_status,
    planned_date: job.planned_date ?? "", supervisor: job.supervisor ?? "",
    estimated_value_pln: job.estimated_value_pln != null ? String(job.estimated_value_pln) : "", notes: job.notes ?? "",
  });
  const [saving, setSaving] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [np, setNp] = useState({ name: "", category: "reszta" as Category, spec: "", asking: "", min: "", location: "" });
  const [sellingId, setSellingId] = useState<string | null>(null);
  const [sf, setSf] = useState({ buyer: "", price: "", date: todayStr(), invoice: "" });

  const owned = isOwned(job.ownership_status);
  const sold = parts.reduce((s, p) => s + Number(saleByPart.get(p.id)?.sale_price_pln ?? 0), 0);
  const remaining = parts
    .filter((p) => p.status !== "sprzedana" && p.status !== "zlomowana")
    .reduce((s, p) => s + Number(p.asking_price_pln ?? 0), 0);
  const estimate = Number(job.estimated_value_pln ?? 0);

  async function saveJob() {
    setSaving(true);
    await supabase.from("dismantle_jobs").update({
      status: form.status,
      ownership_status: form.ownership_status,
      planned_date: form.planned_date || null,
      done_date: form.status === "zakonczona" ? (job.done_date ?? todayStr()) : null,
      supervisor: form.supervisor || null,
      estimated_value_pln: num(form.estimated_value_pln),
      notes: form.notes || null,
      updated_at: new Date().toISOString(),
    }).eq("id", job.id);
    setSaving(false); setEdit(false); onChanged();
  }

  async function addPart() {
    if (!np.name.trim()) return;
    await supabase.from("vehicle_parts").insert({
      vehicle_reg: job.vehicle_reg, name: np.name.trim(), category: np.category, spec: np.spec || null,
      asking_price_pln: num(np.asking), min_price_pln: num(np.min), location: np.location || null,
      created_by: session.user.id,
    });
    setNp({ name: "", category: "reszta", spec: "", asking: "", min: "", location: "" });
    setShowAdd(false); onChanged();
  }

  async function setPartStatus(p: Part, status: PartStatus) {
    if (SALE_STATUSES.includes(status) && !owned) return;
    await supabase.from("vehicle_parts").update({ status, updated_at: new Date().toISOString() }).eq("id", p.id);
    onChanged();
  }

  async function deletePart(p: Part) {
    if (!confirm(`Usunąć część „${p.name}”?`)) return;
    await supabase.from("vehicle_parts").delete().eq("id", p.id);
    onChanged();
  }

  async function sellPart(p: Part) {
    const price = num(sf.price);
    if (price == null) return;
    if (p.min_price_pln != null && price < Number(p.min_price_pln)
      && !confirm(`Cena ${fmtPLN(price)} jest niższa od minimalnej (${fmtPLN(Number(p.min_price_pln))}). Zapisać mimo to?`)) return;
    await supabase.from("part_sales").insert({
      part_id: p.id, buyer: sf.buyer || null, sale_price_pln: price, sale_date: sf.date || todayStr(),
      invoice_no: sf.invoice || null, created_by: session.user.id,
    });
    setSellingId(null); setSf({ buyer: "", price: "", date: todayStr(), invoice: "" }); onChanged();
  }

  async function togglePaid(s: Sale) {
    await supabase.from("part_sales").update({ payment_status: s.payment_status === "zaplacone" ? "oczekuje" : "zaplacone" }).eq("id", s.id);
    onChanged();
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900 font-mono">{job.vehicle_reg}
            <span className="font-sans font-normal text-slate-500 text-base ml-2">{[vehicle?.brand, vehicle?.model].filter(Boolean).join(" ")}</span>
          </h2>
          <span className={`text-xs px-2 py-0.5 rounded-full ${JOB_COLORS[job.status]}`}>{JOB_LABELS[job.status]}</span>
          {vehicle && !vehicle.is_active && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 ml-1.5">Pojazd nieaktywny</span>}
        </div>
        <div className="flex gap-2">
          {!edit && <button className="text-xs text-blue-600 hover:underline" onClick={() => setEdit(true)}>Edytuj</button>}
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>
      </div>

      {!owned && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          <strong>Własność pojazdu niepotwierdzona ({OWNERSHIP_LABELS[job.ownership_status]}).</strong> Pojazd na aktywnym leasingu należy do leasingodawcy —
          wystawianie i rezerwacja części są zablokowane do czasu wykupu lub zgody leasingodawcy. Zmień status własności w „Edytuj”.
          {vehicle?.leasing_eur_mo ? ` Leasing: ${Math.round(vehicle.leasing_eur_mo)} EUR/mc` : ""}
          {vehicle?.leasing_end_date ? ` do ${vehicle.leasing_end_date}` : ""}
          {vehicle?.buyout_eur ? `, wykup: ${Math.round(vehicle.buyout_eur)} EUR` : ""}.
        </div>
      )}

      {edit ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Status rozbiórki</label>
              <select className="input-field bg-white" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as JobStatus })}>
                {(Object.keys(JOB_LABELS) as JobStatus[]).map((s) => <option key={s} value={s}>{JOB_LABELS[s]}</option>)}
              </select></div>
            <div><label className="label">Własność pojazdu</label>
              <select className="input-field bg-white" value={form.ownership_status} onChange={(e) => setForm({ ...form, ownership_status: e.target.value as Ownership })}>
                {(Object.keys(OWNERSHIP_LABELS) as Ownership[]).map((s) => <option key={s} value={s}>{OWNERSHIP_LABELS[s]}</option>)}
              </select></div>
            <div><label className="label">Planowany termin</label>
              <input type="date" className="input-field" value={form.planned_date} onChange={(e) => setForm({ ...form, planned_date: e.target.value })} /></div>
            <div><label className="label">Nadzoruje</label>
              <input className="input-field" value={form.supervisor} onChange={(e) => setForm({ ...form, supervisor: e.target.value })} /></div>
            <div className="col-span-2"><label className="label">Kosztorys — spodziewany przychód (PLN)</label>
              <input className="input-field" inputMode="decimal" value={form.estimated_value_pln} onChange={(e) => setForm({ ...form, estimated_value_pln: e.target.value })} /></div>
            <div className="col-span-2"><label className="label">Notatki</label>
              <textarea className="input-field" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={saving} onClick={saveJob}>{saving ? "Zapisuję…" : "Zapisz"}</button>
            <button className="btn-secondary" onClick={() => setEdit(false)}>Anuluj</button>
          </div>
        </div>
      ) : (
        <div className="text-sm text-slate-600 space-y-0.5">
          <div>Własność: <strong>{OWNERSHIP_LABELS[job.ownership_status]}</strong></div>
          {job.planned_date && <div>Planowany termin: {job.planned_date}</div>}
          {job.supervisor && <div>Nadzoruje: {job.supervisor}</div>}
          {job.notes && <div className="text-slate-500">{job.notes}</div>}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-slate-50 rounded-lg p-2"><div className="text-[11px] text-slate-500 uppercase">Kosztorys</div><div className="font-semibold text-sm">{estimate ? fmtPLN(estimate) : "—"}</div></div>
        <div className="bg-emerald-50 rounded-lg p-2"><div className="text-[11px] text-slate-500 uppercase">Sprzedano</div><div className="font-semibold text-sm text-emerald-700">{fmtPLN(sold)}</div></div>
        <div className="bg-blue-50 rounded-lg p-2"><div className="text-[11px] text-slate-500 uppercase">Na stanie (wywoł.)</div><div className="font-semibold text-sm text-blue-700">{fmtPLN(remaining)}</div></div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Części ({parts.length})</h3>
          <button className="text-xs text-blue-600 hover:underline" onClick={() => setShowAdd((v) => !v)}>+ Dodaj część</button>
        </div>

        {showAdd && (
          <div className="bg-slate-50 rounded-lg p-3 space-y-2 mb-3">
            <div className="grid grid-cols-2 gap-2">
              <input className="input-field col-span-2" placeholder="Nazwa (np. Silnik DAF MX-13)" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} />
              <select className="input-field bg-white" value={np.category} onChange={(e) => setNp({ ...np, category: e.target.value as Category })}>
                {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
              <input className="input-field" placeholder="Lokalizacja (plac / magazyn)" value={np.location} onChange={(e) => setNp({ ...np, location: e.target.value })} />
              <input className="input-field" inputMode="decimal" placeholder="Cena wywoławcza PLN" value={np.asking} onChange={(e) => setNp({ ...np, asking: e.target.value })} />
              <input className="input-field" inputMode="decimal" placeholder="Cena minimalna PLN" value={np.min} onChange={(e) => setNp({ ...np, min: e.target.value })} />
              <input className="input-field col-span-2" placeholder="Specyfikacja (nr silnika, moc, przebieg, stan)" value={np.spec} onChange={(e) => setNp({ ...np, spec: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <button className="btn-primary text-sm" disabled={!np.name.trim()} onClick={addPart}>Zapisz część</button>
              <button className="btn-secondary text-sm" onClick={() => setShowAdd(false)}>Anuluj</button>
            </div>
          </div>
        )}

        {parts.length === 0 ? <div className="text-sm text-slate-400">Brak części — dodaj wysokowartościowe elementy (silnik, skrzynia, mosty, kabina, koła) i jedną pozycję „reszta”.</div> : (
          <div className="space-y-2">
            {parts.map((p) => {
              const sale = saleByPart.get(p.id);
              return (
                <div key={p.id} className="bg-slate-50 rounded-lg p-2.5 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-800">{p.name}</div>
                      <div className="text-xs text-slate-500">
                        {CATEGORY_LABELS[p.category]}{p.location ? ` · ${p.location}` : ""}{p.spec ? ` · ${p.spec}` : ""}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      {sale
                        ? <div className="text-xs font-semibold text-emerald-700">{fmtPLN(Number(sale.sale_price_pln))}</div>
                        : <div className="text-xs text-slate-600">{p.asking_price_pln != null ? fmtPLN(Number(p.asking_price_pln)) : "bez ceny"}
                            {p.min_price_pln != null && <span className="text-slate-400"> (min {fmtPLN(Number(p.min_price_pln))})</span>}</div>}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {p.status === "sprzedana" ? (
                      <>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${PART_COLORS.sprzedana}`}>Sprzedana</span>
                        {sale && <span className="text-xs text-slate-500">{sale.buyer ?? "—"} · {sale.sale_date}{sale.invoice_no ? ` · ${sale.invoice_no}` : ""}</span>}
                        {sale && <button className="text-xs text-blue-600 hover:underline" onClick={() => togglePaid(sale)}>
                          {sale.payment_status === "zaplacone" ? "✓ zapłacone" : "oczekuje na płatność"}</button>}
                      </>
                    ) : (
                      <>
                        <select className="text-xs border border-slate-200 rounded px-1.5 py-1 bg-white" value={p.status}
                          onChange={(e) => setPartStatus(p, e.target.value as PartStatus)}>
                          {(Object.keys(PART_LABELS) as PartStatus[]).filter((s) => s !== "sprzedana").map((s) => (
                            <option key={s} value={s} disabled={SALE_STATUSES.includes(s) && !owned}>{PART_LABELS[s]}</option>
                          ))}
                        </select>
                        <button className="text-xs text-emerald-700 hover:underline disabled:text-slate-300 disabled:no-underline" disabled={!owned}
                          title={owned ? "" : "Własność pojazdu niepotwierdzona"}
                          onClick={() => { setSellingId(sellingId === p.id ? null : p.id); setSf({ buyer: "", price: p.asking_price_pln != null ? String(p.asking_price_pln) : "", date: todayStr(), invoice: "" }); }}>
                          Sprzedaj
                        </button>
                        <button className="text-xs text-red-500 hover:underline ml-auto" onClick={() => deletePart(p)}>Usuń</button>
                      </>
                    )}
                  </div>

                  {sellingId === p.id && (
                    <div className="mt-2 bg-white rounded-lg p-2 grid grid-cols-2 gap-2">
                      <input className="input-field" placeholder="Kupujący" value={sf.buyer} onChange={(e) => setSf({ ...sf, buyer: e.target.value })} />
                      <input className="input-field" inputMode="decimal" placeholder="Cena sprzedaży PLN" value={sf.price} onChange={(e) => setSf({ ...sf, price: e.target.value })} />
                      <input type="date" className="input-field" value={sf.date} onChange={(e) => setSf({ ...sf, date: e.target.value })} />
                      <input className="input-field" placeholder="Nr faktury" value={sf.invoice} onChange={(e) => setSf({ ...sf, invoice: e.target.value })} />
                      <div className="col-span-2 flex gap-2">
                        <button className="btn-primary text-sm" disabled={num(sf.price) == null} onClick={() => sellPart(p)}>Zapisz sprzedaż</button>
                        <button className="btn-secondary text-sm" onClick={() => setSellingId(null)}>Anuluj</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
