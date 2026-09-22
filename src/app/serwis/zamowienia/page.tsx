"use client";

import { useState, useEffect, useCallback } from "react";
import type { AuthSession as Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

// ══════════════════════════════════════════════════════════════
// /serwis/zamowienia — zamawianie części warsztatowych z akceptacją
// Kacper zgłasza, Chytrowski lub Rafał (Maciej Witkowski jako zastępca)
// zatwierdza/odrzuca. W ODRÓŻNIENIU od reszty /serwis (bez logowania)
// TA podstrona wymaga konta — bez tego "kto zgłosił/zatwierdził" nie
// miałoby sensu. Wzorowane na /akceptacje (migracja 023), role i dane
// trzymane osobno (migracja 024, part_order_roles / part_orders).
// ══════════════════════════════════════════════════════════════

type Status = "oczekuje" | "zatwierdzona" | "odrzucona";
type Role = "submitter" | "approver" | "viewer";

interface PartOrder {
  id: string;
  part_name: string;
  part_number: string | null;
  quantity: number;
  vehicle_reg: string | null;
  estimated_cost_pln: number | null;
  stock_checked: boolean;
  vendor: string | null;
  notes: string | null;
  status: Status;
  submitted_by: string;
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}
interface Profile { id: string; display_name: string | null; email: string | null }
interface VehicleLite { reg: string; brand: string | null; model: string | null }

const STATUS_LABELS: Record<Status, string> = { oczekuje: "Oczekuje", zatwierdzona: "Zatwierdzona", odrzucona: "Odrzucona" };
const STATUS_COLORS: Record<Status, string> = {
  oczekuje: "bg-amber-100 text-amber-700", zatwierdzona: "bg-emerald-100 text-emerald-700", odrzucona: "bg-red-100 text-red-700",
};
const fmtPln = (n: number) => Math.round(n).toLocaleString("pl-PL") + " PLN";
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "—");
const num = (s: string) => { const n = parseFloat(s.replace(",", ".")); return isNaN(n) ? null : n; };

export default function ZamowieniaCzesciPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checking) return <div className="p-8 text-sm text-slate-400">Sprawdzam sesję…</div>;
  if (!session) return <LoginScreen />;
  return <Dashboard session={session} />;
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
        <h1 className="text-lg font-bold text-slate-900 mb-1">Zamawianie części</h1>
        <p className="text-sm text-slate-500 mb-4">Dostęp tylko dla zalogowanych z przypisaną rolą (zgłaszający / zatwierdzający).</p>
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

async function notifyTeams(payload: object) {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await fetch("/api/serwis/zamowienia/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
  } catch {
    // Powiadomienie na Teams nie jest krytyczne — zgłoszenie/decyzja już
    // zapisane w bazie niezależnie od tego, czy webhook zadziałał.
  }
}

function Dashboard({ session }: { session: Session }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [orders, setOrders] = useState<PartOrder[]>([]);
  const [vehicles, setVehicles] = useState<VehicleLite[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"do_zatwierdzenia" | "zamow" | "historia">("do_zatwierdzenia");

  const isSubmitter = roles.includes("submitter");
  const isApprover = roles.includes("approver");
  const hasAnyRole = roles.length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    const [r, o, v, p] = await Promise.all([
      supabase.from("part_order_roles").select("role").eq("user_id", session.user.id),
      supabase.from("part_orders").select("*").order("submitted_at", { ascending: false }),
      supabase.from("vehicles").select("reg,brand,model").order("reg", { ascending: true }),
      supabase.from("profiles").select("id,display_name,email"),
    ]);
    const err = r.error ?? o.error;
    if (err) {
      setLoadError(err.message.includes("schema cache") || err.message.includes("does not exist")
        ? "Brak tabel modułu — uruchom migrację 024_part_orders.sql w Supabase Studio."
        : err.message);
    } else setLoadError(null);
    setRoles(((r.data ?? []) as { role: Role }[]).map((x) => x.role));
    setRolesLoaded(true);
    setOrders((o.data ?? []) as PartOrder[]);
    setVehicles((v.data ?? []) as VehicleLite[]);
    const pm: Record<string, Profile> = {};
    ((p.data ?? []) as Profile[]).forEach((x) => (pm[x.id] = x));
    setProfiles(pm);
    setLoading(false);
  }, [session.user.id]);
  useEffect(() => { load(); }, [load]);

  const nameOf = (id: string | null) => (id ? profiles[id]?.display_name ?? profiles[id]?.email ?? id.slice(0, 8) : "—");
  const pending = orders.filter((o) => o.status === "oczekuje");
  const myPending = pending.filter((o) => o.submitted_by === session.user.id);

  if (rolesLoaded && !hasAnyRole && !loadError) {
    return (
      <div className="card max-w-lg mx-auto mt-12 text-center">
        <h1 className="text-lg font-bold text-slate-900 mb-2">Zamawianie części</h1>
        <p className="text-sm text-slate-500">
          Twoje konto ({session.user.email}) nie ma przypisanej roli w tym module (zgłaszający / zatwierdzający / obserwator).
          Poproś administratora o dopisanie w tabeli <code className="bg-slate-100 px-1 rounded">part_order_roles</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Zamawianie części</h1>
          <p className="text-slate-500 text-sm mt-1">
            {pending.length} oczekujących · Twoja rola: {roles.map((r) => ({ submitter: "zgłaszający", approver: "zatwierdzający", viewer: "obserwator" }[r])).join(", ") || "—"}
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-500">{session.user.email}</span>
          <button className="text-slate-400 hover:text-slate-700" onClick={() => supabase.auth.signOut()}>Wyloguj</button>
        </div>
      </div>

      {loadError && <div className="card text-sm text-red-600">{loadError}</div>}

      <div className="flex gap-1 border-b border-slate-200 flex-wrap">
        <button onClick={() => setTab("do_zatwierdzenia")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "do_zatwierdzenia" ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
          Do zatwierdzenia {pending.length > 0 && <span className="ml-1 bg-amber-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{pending.length}</span>}
        </button>
        {isSubmitter && (
          <button onClick={() => setTab("zamow")}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "zamow" ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            Zamów część
          </button>
        )}
        <button onClick={() => setTab("historia")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "historia" ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
          Historia
        </button>
      </div>

      {loading ? <div className="p-6 text-sm text-slate-400">Ładowanie…</div> : (
        <>
          {tab === "do_zatwierdzenia" && (
            <PendingList items={pending} isApprover={isApprover} nameOf={nameOf} session={session} myPending={myPending} onChanged={load} />
          )}
          {tab === "zamow" && isSubmitter && (
            <OrderForm session={session} vehicles={vehicles} onChanged={() => { load(); setTab("do_zatwierdzenia"); }} />
          )}
          {tab === "historia" && <HistoryTable items={orders} nameOf={nameOf} />}
        </>
      )}
    </div>
  );
}

function PendingList({
  items, isApprover, nameOf, session, myPending, onChanged,
}: {
  items: PartOrder[]; isApprover: boolean; nameOf: (id: string | null) => string; session: Session;
  myPending: PartOrder[]; onChanged: () => void;
}) {
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function approve(o: PartOrder) {
    setBusy(o.id);
    const { error } = await supabase.from("part_orders")
      .update({ status: "zatwierdzona", decided_by: session.user.id, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", o.id);
    setBusy(null);
    if (!error) {
      notifyTeams({ kind: "approved", partName: o.part_name, quantity: o.quantity, estimatedCostPln: o.estimated_cost_pln, vehicleReg: o.vehicle_reg, vendor: o.vendor, decidedByName: session.user.email });
      onChanged();
    }
  }
  async function reject(o: PartOrder) {
    if (!rejectNote.trim()) return;
    setBusy(o.id);
    const { error } = await supabase.from("part_orders")
      .update({ status: "odrzucona", decided_by: session.user.id, decided_at: new Date().toISOString(), decision_note: rejectNote.trim(), updated_at: new Date().toISOString() })
      .eq("id", o.id);
    setBusy(null);
    if (!error) {
      notifyTeams({ kind: "rejected", partName: o.part_name, quantity: o.quantity, estimatedCostPln: o.estimated_cost_pln, vehicleReg: o.vehicle_reg, vendor: o.vendor, decidedByName: session.user.email, decisionNote: rejectNote.trim() });
      setRejecting(null); setRejectNote(""); onChanged();
    }
  }
  async function withdraw(o: PartOrder) {
    if (!confirm(`Wycofać zamówienie „${o.part_name}”?`)) return;
    await supabase.from("part_orders").delete().eq("id", o.id);
    onChanged();
  }

  if (items.length === 0) return <div className="card text-sm text-slate-400 text-center py-8">Brak zamówień oczekujących na decyzję.</div>;

  return (
    <div className="space-y-3">
      {items.map((o) => {
        const mine = myPending.some((m) => m.id === o.id);
        return (
          <div key={o.id} className="card">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="font-semibold text-slate-800">{o.part_name} <span className="font-normal text-slate-500">× {o.quantity}</span></div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {o.part_number && <>nr kat. {o.part_number} · </>}
                  {o.vehicle_reg ? <>pojazd {o.vehicle_reg}</> : <>zamówienie ogólne</>}
                  {o.vendor && <> · {o.vendor}</>}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">Zgłosił {nameOf(o.submitted_by)} · {fmtDate(o.submitted_at)}</div>
                {o.stock_checked && (
                  <div className="text-xs text-emerald-600 mt-0.5">✓ Zweryfikowano brak towaru na magazynie</div>
                )}
                {o.notes && <div className="text-xs text-slate-500 mt-1 italic">„{o.notes}”</div>}
              </div>
              <div className="text-right shrink-0">
                {o.estimated_cost_pln != null && <div className="text-lg font-bold text-slate-800">{fmtPln(o.estimated_cost_pln)}</div>}
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[o.status]}`}>{STATUS_LABELS[o.status]}</span>
              </div>
            </div>

            {isApprover && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                {rejecting === o.id ? (
                  <div className="space-y-2">
                    <input className="input-field" placeholder="Powód odrzucenia (wymagany)" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
                    <div className="flex gap-2">
                      <button className="btn-primary bg-red-600 hover:bg-red-700 text-sm" disabled={!rejectNote.trim() || busy === o.id} onClick={() => reject(o)}>
                        {busy === o.id ? "Zapisuję…" : "Potwierdź odrzucenie"}
                      </button>
                      <button className="btn-secondary text-sm" onClick={() => { setRejecting(null); setRejectNote(""); }}>Anuluj</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button className="btn-primary text-sm" disabled={busy === o.id} onClick={() => approve(o)}>
                      {busy === o.id ? "Zapisuję…" : "✓ Zatwierdź"}
                    </button>
                    <button className="btn-secondary text-sm text-red-600" disabled={busy === o.id} onClick={() => setRejecting(o.id)}>
                      ✕ Odrzuć
                    </button>
                  </div>
                )}
              </div>
            )}
            {!isApprover && mine && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <button className="text-xs text-red-500 hover:underline" onClick={() => withdraw(o)}>Wycofaj zamówienie</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OrderForm({ session, vehicles, onChanged }: { session: Session; vehicles: VehicleLite[]; onChanged: () => void }) {
  const [partName, setPartName] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [vehicleReg, setVehicleReg] = useState("");
  const [cost, setCost] = useState("");
  const [vendor, setVendor] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [vehSearch, setVehSearch] = useState("");
  const [stockChecked, setStockChecked] = useState(false);

  const filteredVehicles = vehicles.filter((v) => {
    const q = vehSearch.toLowerCase().trim();
    if (!q) return true;
    return [v.reg, v.brand, v.model].some((f) => (f ?? "").toLowerCase().includes(q));
  });

  async function submit() {
    const qty = num(quantity);
    if (!partName.trim() || qty == null || qty <= 0 || !stockChecked) return;
    setSaving(true);
    const estimatedCost = num(cost);
    const { error } = await supabase.from("part_orders").insert({
      part_name: partName.trim(),
      part_number: partNumber.trim() || null,
      quantity: qty,
      vehicle_reg: vehicleReg || null,
      estimated_cost_pln: estimatedCost,
      vendor: vendor.trim() || null,
      notes: notes.trim() || null,
      submitted_by: session.user.id,
      stock_checked: stockChecked,
    });
    setSaving(false);
    if (!error) {
      notifyTeams({ kind: "submitted", partName: partName.trim(), quantity: qty, estimatedCostPln: estimatedCost, vehicleReg: vehicleReg || null, vendor: vendor.trim() || null, submittedByName: session.user.email });
      setPartName(""); setPartNumber(""); setQuantity("1"); setVehicleReg(""); setCost(""); setVendor(""); setNotes(""); setStockChecked(false);
      onChanged();
    } else {
      alert("Nie udało się zapisać: " + error.message);
    }
  }

  return (
    <div className="card max-w-2xl space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="label">Nazwa części</label>
          <input className="input-field" value={partName} onChange={(e) => setPartName(e.target.value)} placeholder="np. Filtr oleju MAN TGX" /></div>
        <div><label className="label">Nr katalogowy (opcjonalnie)</label>
          <input className="input-field" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} /></div>
        <div><label className="label">Ilość</label>
          <input className="input-field" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
        <div><label className="label">Szacowany koszt (PLN, opcjonalnie)</label>
          <input className="input-field" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></div>
        <div><label className="label">Dostawca (opcjonalnie)</label>
          <input className="input-field" value={vendor} onChange={(e) => setVendor(e.target.value)} /></div>

        <div className="col-span-2">
          <label className="label">Pojazd (opcjonalnie — zostaw puste dla zamówienia ogólnego)</label>
          <input className="input-field mb-1.5" placeholder="Szukaj pojazdu: nr rej., marka, model…" value={vehSearch} onChange={(e) => setVehSearch(e.target.value)} />
          <select className="input-field bg-white" value={vehicleReg} onChange={(e) => setVehicleReg(e.target.value)}>
            <option value="">— zamówienie ogólne, bez pojazdu —</option>
            {filteredVehicles.map((v) => (
              <option key={v.reg} value={v.reg}>{v.reg} · {[v.brand, v.model].filter(Boolean).join(" ")}</option>
            ))}
          </select>
        </div>

        <div className="col-span-2"><label className="label">Notatka (opcjonalnie)</label>
          <textarea className="input-field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </div>

      <label className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-lg p-3 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={stockChecked} onChange={(e) => setStockChecked(e.target.checked)} />
        <span className="text-sm text-amber-900">
          <strong>Zweryfikowano brak towaru na magazynie warsztatu.</strong> Sprawdziłem/am fizycznie, że tej części nie ma
          na stanie, zanim zgłosiłem/am zamówienie.
        </span>
      </label>

      <button className="btn-primary" disabled={saving || !partName.trim() || num(quantity) == null || !stockChecked} onClick={submit}>
        {saving ? "Zgłaszam…" : "Zgłoś do akceptacji"}
      </button>
    </div>
  );
}

function HistoryTable({ items, nameOf }: { items: PartOrder[]; nameOf: (id: string | null) => string }) {
  if (items.length === 0) return <div className="card text-sm text-slate-400 text-center py-8">Brak historii.</div>;
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b">
          <tr className="text-left text-xs text-slate-500 uppercase">
            <th className="px-4 py-2">Część</th><th className="px-4 py-2 text-right">Ilość</th>
            <th className="px-4 py-2 text-right">Koszt</th><th className="px-4 py-2">Pojazd</th>
            <th className="px-4 py-2">Zgłosił</th><th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Decyzja</th><th className="px-4 py-2">Uwaga</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((o) => (
            <tr key={o.id} className="hover:bg-slate-50">
              <td className="px-4 py-2">{o.part_name}{o.part_number && <div className="text-xs text-slate-400">{o.part_number}</div>}</td>
              <td className="px-4 py-2 text-right font-mono">{o.quantity}</td>
              <td className="px-4 py-2 text-right font-mono">{o.estimated_cost_pln != null ? fmtPln(o.estimated_cost_pln) : "—"}</td>
              <td className="px-4 py-2 text-xs font-mono">{o.vehicle_reg ?? "—"}</td>
              <td className="px-4 py-2 text-xs">{nameOf(o.submitted_by)}</td>
              <td className="px-4 py-2"><span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[o.status]}`}>{STATUS_LABELS[o.status]}</span></td>
              <td className="px-4 py-2 text-xs text-slate-500">{o.decided_by ? `${nameOf(o.decided_by)} · ${fmtDate(o.decided_at)}` : "—"}</td>
              <td className="px-4 py-2 text-xs text-slate-500 italic">{o.decision_note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
