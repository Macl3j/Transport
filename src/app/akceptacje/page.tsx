"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { AuthSession as Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

// ══════════════════════════════════════════════════════════════
// /akceptacje — podwójna akceptacja płatności (ustalenie z narady 15.09.2026)
// Hubert zgłasza płatność (z rejestru kosztów albo ręcznie), Rafał — lub
// zastępca — zatwierdza bądź odrzuca z komentarzem, wyznaczeni obserwatorzy
// widzą historię. Kto zgłasza/zatwierdza/widzi jest w tabeli
// finance_approval_roles (migracja 023), nie na sztywno w kodzie.
// ══════════════════════════════════════════════════════════════

type Status = "oczekuje" | "zatwierdzona" | "odrzucona";
type Source = "rejestr" | "reczne";
type Role = "submitter" | "approver" | "viewer";

interface Approval {
  id: string;
  source: Source;
  cost_invoice_id: string | null;
  vendor: string;
  amount_pln: number;
  title: string | null;
  due_date: string | null;
  notes: string | null;
  status: Status;
  submitted_by: string;
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}
interface CostInvoice {
  id: string;
  numer: string | null;
  sprzedawca: string | null;
  termin_platnosci: string | null;
  brutto_pln: number | null;
  pozostalo_do_zaplaty_pln: number | null;
  status_splaty: string | null;
}
interface Profile { id: string; display_name: string | null; email: string | null }

const STATUS_LABELS: Record<Status, string> = { oczekuje: "Oczekuje", zatwierdzona: "Zatwierdzona", odrzucona: "Odrzucona" };
const STATUS_COLORS: Record<Status, string> = {
  oczekuje: "bg-amber-100 text-amber-700", zatwierdzona: "bg-emerald-100 text-emerald-700", odrzucona: "bg-red-100 text-red-700",
};
const fmtPln = (n: number) => Math.round(n).toLocaleString("pl-PL") + " PLN";
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("pl-PL") : "—");
const num = (s: string) => { const n = parseFloat(s.replace(",", ".")); return isNaN(n) ? null : n; };

// ── Bramka logowania — ten sam login co CRM / windykacja / części ──
export default function AkceptacjePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checking) return <div className="p-8 text-sm text-slate-400">Sprawdzam sesję…</div>;
  if (!session) return <LoginScreen />;
  return <AkceptacjeDashboard session={session} />;
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
        <h1 className="text-lg font-bold text-slate-900 mb-1">Akceptacja płatności</h1>
        <p className="text-sm text-slate-500 mb-4">Dostęp tylko dla zalogowanych z przypisaną rolą (ten sam login co CRM).</p>
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
    await fetch("/api/akceptacje/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
  } catch {
    // Powiadomienie na Teams nie jest krytyczne — zgłoszenie/decyzja już
    // zapisane w bazie niezależnie od tego, czy webhook zadziałał.
  }
}

function AkceptacjeDashboard({ session }: { session: Session }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [invoices, setInvoices] = useState<CostInvoice[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"do_zatwierdzenia" | "zglos" | "historia">("do_zatwierdzenia");

  const isSubmitter = roles.includes("submitter");
  const isApprover = roles.includes("approver");
  const hasAnyRole = roles.length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    const [r, a, inv, p] = await Promise.all([
      supabase.from("finance_approval_roles").select("role").eq("user_id", session.user.id),
      supabase.from("payment_approvals").select("*").order("submitted_at", { ascending: false }),
      // Tabela ma tysiące wierszy (głównie już spłacone) — bez filtra i sortowania
      // po stronie zapytania samo .limit(1000) potrafi trafić w same opłacone
      // i lista "do wyboru" wychodzi pusta mimo realnych niezapłaconych faktur.
      // .neq() sam odrzuca NULL-e, więc trzeba je dopisać osobno przez .or().
      supabase.from("cost_invoices")
        .select("id,numer,sprzedawca,termin_platnosci,brutto_pln,pozostalo_do_zaplaty_pln,status_splaty")
        .or("status_splaty.neq.Spłacony,status_splaty.is.null")
        .order("termin_platnosci", { ascending: true, nullsFirst: false })
        .limit(1000),
      supabase.from("profiles").select("id,display_name,email"),
    ]);
    const err = r.error ?? a.error;
    if (err) {
      setLoadError(err.message.includes("schema cache") || err.message.includes("does not exist")
        ? "Brak tabel modułu — uruchom migrację 023_payment_approvals.sql w Supabase Studio."
        : err.message);
    } else setLoadError(null);
    setRoles(((r.data ?? []) as { role: Role }[]).map((x) => x.role));
    setRolesLoaded(true);
    setApprovals((a.data ?? []) as Approval[]);
    setInvoices((inv.data ?? []) as CostInvoice[]);
    const pm: Record<string, Profile> = {};
    ((p.data ?? []) as Profile[]).forEach((x) => (pm[x.id] = x));
    setProfiles(pm);
    setLoading(false);
  }, [session.user.id]);
  useEffect(() => { load(); }, [load]);

  const nameOf = (id: string | null) => (id ? profiles[id]?.display_name ?? profiles[id]?.email ?? id.slice(0, 8) : "—");

  const unpaidInvoices = useMemo(() => invoices.filter((i) =>
    i.status_splaty !== "Spłacony" && (i.pozostalo_do_zaplaty_pln ?? i.brutto_pln ?? 0) > 0.01
  ), [invoices]);

  const pending = approvals.filter((a) => a.status === "oczekuje");
  const myPendingSubmissions = pending.filter((a) => a.submitted_by === session.user.id);

  if (rolesLoaded && !hasAnyRole && !loadError) {
    return (
      <div className="card max-w-lg mx-auto mt-12 text-center">
        <h1 className="text-lg font-bold text-slate-900 mb-2">Akceptacja płatności</h1>
        <p className="text-sm text-slate-500">
          Twoje konto ({session.user.email}) nie ma przypisanej roli w tym module (zgłaszający / zatwierdzający / obserwator).
          Poproś administratora o dopisanie w tabeli <code className="bg-slate-100 px-1 rounded">finance_approval_roles</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Akceptacja płatności</h1>
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
          <button onClick={() => setTab("zglos")}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === "zglos" ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            Zgłoś płatność
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
            <PendingList
              items={pending}
              isApprover={isApprover}
              nameOf={nameOf}
              session={session}
              myPendingSubmissions={myPendingSubmissions}
              onChanged={load}
            />
          )}
          {tab === "zglos" && isSubmitter && (
            <SubmitForm session={session} invoices={unpaidInvoices} onChanged={() => { load(); setTab("do_zatwierdzenia"); }} />
          )}
          {tab === "historia" && <HistoryTable items={approvals} nameOf={nameOf} />}
        </>
      )}
    </div>
  );
}

function PendingList({
  items, isApprover, nameOf, session, myPendingSubmissions, onChanged,
}: {
  items: Approval[]; isApprover: boolean; nameOf: (id: string | null) => string; session: Session;
  myPendingSubmissions: Approval[]; onChanged: () => void;
}) {
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function approve(a: Approval) {
    setBusy(a.id);
    const { error } = await supabase.from("payment_approvals")
      .update({ status: "zatwierdzona", decided_by: session.user.id, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", a.id);
    setBusy(null);
    if (!error) {
      notifyTeams({ kind: "approved", vendor: a.vendor, amountPln: a.amount_pln, title: a.title, decidedByName: session.user.email });
      onChanged();
    }
  }
  async function reject(a: Approval) {
    if (!rejectNote.trim()) return;
    setBusy(a.id);
    const { error } = await supabase.from("payment_approvals")
      .update({ status: "odrzucona", decided_by: session.user.id, decided_at: new Date().toISOString(), decision_note: rejectNote.trim(), updated_at: new Date().toISOString() })
      .eq("id", a.id);
    setBusy(null);
    if (!error) {
      notifyTeams({ kind: "rejected", vendor: a.vendor, amountPln: a.amount_pln, title: a.title, decidedByName: session.user.email, decisionNote: rejectNote.trim() });
      setRejecting(null); setRejectNote(""); onChanged();
    }
  }
  async function withdraw(a: Approval) {
    if (!confirm(`Wycofać zgłoszenie „${a.vendor}” (${fmtPln(a.amount_pln)})?`)) return;
    await supabase.from("payment_approvals").delete().eq("id", a.id);
    onChanged();
  }

  if (items.length === 0) return <div className="card text-sm text-slate-400 text-center py-8">Brak zgłoszeń oczekujących na decyzję.</div>;

  return (
    <div className="space-y-3">
      {items.map((a) => {
        const mine = myPendingSubmissions.some((m) => m.id === a.id);
        return (
          <div key={a.id} className="card">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="font-semibold text-slate-800">{a.vendor}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {a.title && <>{a.title} · </>}
                  {a.source === "rejestr" ? "z rejestru kosztów" : "wpis ręczny"}
                  {a.due_date && <> · termin {fmtDate(a.due_date)}</>}
                </div>
                <div className="text-xs text-slate-400 mt-0.5">Zgłosił {nameOf(a.submitted_by)} · {fmtDate(a.submitted_at)}</div>
                {a.notes && <div className="text-xs text-slate-500 mt-1 italic">„{a.notes}”</div>}
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-bold text-slate-800">{fmtPln(a.amount_pln)}</div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[a.status]}`}>{STATUS_LABELS[a.status]}</span>
              </div>
            </div>

            {isApprover && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                {rejecting === a.id ? (
                  <div className="space-y-2">
                    <input className="input-field" placeholder="Powód odrzucenia (wymagany)" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
                    <div className="flex gap-2">
                      <button className="btn-primary bg-red-600 hover:bg-red-700 text-sm" disabled={!rejectNote.trim() || busy === a.id} onClick={() => reject(a)}>
                        {busy === a.id ? "Zapisuję…" : "Potwierdź odrzucenie"}
                      </button>
                      <button className="btn-secondary text-sm" onClick={() => { setRejecting(null); setRejectNote(""); }}>Anuluj</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button className="btn-primary text-sm" disabled={busy === a.id} onClick={() => approve(a)}>
                      {busy === a.id ? "Zapisuję…" : "✓ Zatwierdź"}
                    </button>
                    <button className="btn-secondary text-sm text-red-600" disabled={busy === a.id} onClick={() => setRejecting(a.id)}>
                      ✕ Odrzuć
                    </button>
                  </div>
                )}
              </div>
            )}
            {!isApprover && mine && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <button className="text-xs text-red-500 hover:underline" onClick={() => withdraw(a)}>Wycofaj zgłoszenie</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SubmitForm({ session, invoices, onChanged }: { session: Session; invoices: CostInvoice[]; onChanged: () => void }) {
  const [mode, setMode] = useState<Source>("rejestr");
  const [invoiceId, setInvoiceId] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const filteredInvoices = invoices.filter((i) => {
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return [i.numer, i.sprzedawca].some((f) => (f ?? "").toLowerCase().includes(q));
  });

  function pickInvoice(id: string) {
    setInvoiceId(id);
    const inv = invoices.find((i) => i.id === id);
    if (inv) {
      setVendor(inv.sprzedawca ?? "");
      setAmount(String(inv.pozostalo_do_zaplaty_pln ?? inv.brutto_pln ?? ""));
      setTitle(inv.numer ?? "");
      setDueDate(inv.termin_platnosci ?? "");
    }
  }

  async function submit() {
    const amt = num(amount);
    if (!vendor.trim() || amt == null || amt <= 0) return;
    setSaving(true);
    const { error } = await supabase.from("payment_approvals").insert({
      source: mode,
      cost_invoice_id: mode === "rejestr" ? invoiceId || null : null,
      vendor: vendor.trim(),
      amount_pln: amt,
      title: title.trim() || null,
      due_date: dueDate || null,
      notes: notes.trim() || null,
      submitted_by: session.user.id,
    });
    setSaving(false);
    if (!error) {
      notifyTeams({ kind: "submitted", vendor: vendor.trim(), amountPln: amt, title: title.trim() || null, submittedByName: session.user.email });
      setInvoiceId(""); setVendor(""); setAmount(""); setTitle(""); setDueDate(""); setNotes("");
      onChanged();
    } else {
      alert("Nie udało się zapisać: " + error.message);
    }
  }

  return (
    <div className="card max-w-2xl space-y-4">
      <div className="flex gap-1.5">
        <button onClick={() => { setMode("rejestr"); setVendor(""); setAmount(""); setTitle(""); setDueDate(""); }}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${mode === "rejestr" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"}`}>
          Z rejestru kosztów
        </button>
        <button onClick={() => { setMode("reczne"); setInvoiceId(""); setVendor(""); setAmount(""); setTitle(""); setDueDate(""); }}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${mode === "reczne" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"}`}>
          Wpis ręczny (faktura jeszcze niezaimportowana)
        </button>
      </div>

      {mode === "rejestr" && (
        <div>
          <label className="label">Wybierz fakturę ({filteredInvoices.length} nieopłaconych)</label>
          <input className="input-field mb-1.5" placeholder="Szukaj: dostawca, numer faktury…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="input-field bg-white" value={invoiceId} onChange={(e) => pickInvoice(e.target.value)}>
            <option value="">— wybierz fakturę —</option>
            {filteredInvoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.sprzedawca ?? "—"} · {i.numer ?? "brak nr"} · {fmtPln(i.pozostalo_do_zaplaty_pln ?? i.brutto_pln ?? 0)} · termin {fmtDate(i.termin_platnosci)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="label">Kontrahent</label>
          <input className="input-field" value={vendor} onChange={(e) => setVendor(e.target.value)} disabled={mode === "rejestr" && !!invoiceId} /></div>
        <div><label className="label">Kwota (PLN)</label>
          <input className="input-field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={mode === "rejestr" && !!invoiceId} /></div>
        <div><label className="label">Termin płatności</label>
          <input type="date" className="input-field" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
        <div className="col-span-2"><label className="label">Tytuł / numer faktury</label>
          <input className="input-field" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="col-span-2"><label className="label">Notatka (opcjonalnie)</label>
          <textarea className="input-field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </div>

      <button className="btn-primary" disabled={saving || !vendor.trim() || num(amount) == null} onClick={submit}>
        {saving ? "Zgłaszam…" : "Zgłoś do akceptacji"}
      </button>
    </div>
  );
}

function HistoryTable({ items, nameOf }: { items: Approval[]; nameOf: (id: string | null) => string }) {
  if (items.length === 0) return <div className="card text-sm text-slate-400 text-center py-8">Brak historii.</div>;
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b">
          <tr className="text-left text-xs text-slate-500 uppercase">
            <th className="px-4 py-2">Kontrahent</th><th className="px-4 py-2 text-right">Kwota</th>
            <th className="px-4 py-2">Zgłosił</th><th className="px-4 py-2">Zgłoszono</th>
            <th className="px-4 py-2">Status</th><th className="px-4 py-2">Decyzja</th><th className="px-4 py-2">Uwaga</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((a) => (
            <tr key={a.id} className="hover:bg-slate-50">
              <td className="px-4 py-2">{a.vendor}{a.title && <div className="text-xs text-slate-400">{a.title}</div>}</td>
              <td className="px-4 py-2 text-right font-mono">{fmtPln(a.amount_pln)}</td>
              <td className="px-4 py-2 text-xs">{nameOf(a.submitted_by)}</td>
              <td className="px-4 py-2 text-xs text-slate-500">{fmtDate(a.submitted_at)}</td>
              <td className="px-4 py-2"><span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[a.status]}`}>{STATUS_LABELS[a.status]}</span></td>
              <td className="px-4 py-2 text-xs text-slate-500">{a.decided_by ? `${nameOf(a.decided_by)} · ${fmtDate(a.decided_at)}` : "—"}</td>
              <td className="px-4 py-2 text-xs text-slate-500 italic">{a.decision_note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
