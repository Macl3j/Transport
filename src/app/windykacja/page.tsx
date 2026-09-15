"use client";

import { useState, useEffect, useCallback } from "react";
import type { AuthSession as Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

// ── Typy ─────────────────────────────────────────────────────
type CreditorCategory = "leasing" | "kredyt" | "dostawca" | "wynagrodzenia" | "inne";
type CreditorStatus = "otwarte" | "w_negocjacji" | "czesciowo_splacone" | "splacone" | "eskalacja_windykacja";
type EventType = "call" | "email" | "meeting" | "payment" | "status_change" | "note";

interface Creditor {
  id: string;
  name: string;
  category: CreditorCategory;
  total_amount_pln: number;
  status: CreditorStatus;
  original_due_date: string | null;
  contract_terminated: boolean;
  assigned_to: string | null;
  next_action_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface Profile {
  id: string;
  display_name: string | null;
  email: string | null;
}

interface CreditorContact {
  id: string;
  creditor_id: string;
  name: string | null;
  role: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
}

interface CreditorEvent {
  id: string;
  creditor_id: string;
  event_type: EventType;
  event_date: string;
  description: string | null;
  amount_pln: number | null;
  status_after: string | null;
  next_action_date: string | null;
  created_by: string | null;
  created_at: string;
}

const CATEGORY_LABELS: Record<CreditorCategory, string> = {
  leasing: "Leasing", kredyt: "Kredyt", dostawca: "Dostawca", wynagrodzenia: "Wynagrodzenia", inne: "Inne",
};
const STATUS_LABELS: Record<CreditorStatus, string> = {
  otwarte: "Otwarte",
  w_negocjacji: "W negocjacji",
  czesciowo_splacone: "Częściowo spłacone",
  splacone: "Spłacone",
  eskalacja_windykacja: "Eskalacja / windykacja",
};
const STATUS_COLORS: Record<CreditorStatus, string> = {
  otwarte: "bg-slate-100 text-slate-600",
  w_negocjacji: "bg-amber-100 text-amber-700",
  czesciowo_splacone: "bg-blue-100 text-blue-700",
  splacone: "bg-emerald-100 text-emerald-700",
  eskalacja_windykacja: "bg-red-100 text-red-700",
};
const EVENT_LABELS: Record<EventType, string> = {
  call: "📞 Telefon", email: "✉️ E-mail", meeting: "🤝 Spotkanie",
  payment: "💰 Płatność", status_change: "🔄 Zmiana statusu", note: "📝 Notatka",
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function fmtPLN(n: number) {
  return n.toLocaleString("pl-PL", { maximumFractionDigits: 0 }) + " PLN";
}
function nextActionBadge(date: string | null) {
  if (!date) return { text: "brak terminu", cls: "bg-slate-100 text-slate-400" };
  const today = todayStr();
  if (date < today) return { text: `${date} (zaległe)`, cls: "bg-red-100 text-red-700 font-semibold" };
  if (date === today) return { text: `${date} (dziś)`, cls: "bg-amber-100 text-amber-700 font-semibold" };
  return { text: date, cls: "bg-blue-50 text-blue-700" };
}

// ══════════════════════════════════════════════════════════════
// BRAMKA LOGOWANIA — ten sam model dostępu co CRM handlowy
// ══════════════════════════════════════════════════════════════
export default function WindykacjaPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingSession(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checkingSession) {
    return <div className="p-8 text-sm text-slate-400">Sprawdzam sesję…</div>;
  }
  if (!session) {
    return <LoginScreen />;
  }
  return <WindykacjaDashboard session={session} />;
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) setErr(error.message);
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <div className="card w-full max-w-sm">
        <h1 className="text-lg font-bold text-slate-900 mb-1">Windykacja — negocjacje z wierzycielami</h1>
        <p className="text-sm text-slate-500 mb-4">Dostęp tylko dla zalogowanych (ten sam login co CRM handlowy).</p>
        <form className="space-y-3" onSubmit={handleLogin}>
          <div>
            <label className="label">Email</label>
            <input className="input-field" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label">Hasło</label>
            <input className="input-field" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button type="submit" className="btn-primary w-full" disabled={loading}>
            {loading ? "Loguję…" : "Zaloguj"}
          </button>
        </form>
      </div>
    </div>
  );
}

function AccountMenu({ session }: { session: Session }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-slate-500">{session.user.email}</span>
      <button className="text-slate-400 hover:text-slate-700" onClick={() => supabase.auth.signOut()}>
        Wyloguj
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════
function WindykacjaDashboard({ session }: { session: Session }) {
  const [creditors, setCreditors] = useState<Creditor[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | CreditorStatus>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({
    name: "", category: "inne" as CreditorCategory, total_amount_pln: "", notes: "",
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("creditors")
      .select("*")
      .order("next_action_date", { ascending: true, nullsFirst: false })
      .order("total_amount_pln", { ascending: false });
    setCreditors(data ?? []);
    setLoading(false);
  }, []);

  const loadProfiles = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id,display_name,email");
    const map: Record<string, Profile> = {};
    (data ?? []).forEach((p: Profile) => { map[p.id] = p; });
    setProfiles(map);
  }, []);

  useEffect(() => { load(); loadProfiles(); }, [load, loadProfiles]);

  async function handleAddCreditor() {
    if (!newForm.name.trim()) return;
    setSaving(true);
    const { data, error } = await supabase
      .from("creditors")
      .insert({
        name: newForm.name.trim(),
        category: newForm.category,
        total_amount_pln: parseFloat(newForm.total_amount_pln.replace(",", ".")) || 0,
        status: "otwarte",
        notes: newForm.notes || null,
        assigned_to: session.user.id,
      })
      .select("id")
      .single();
    setSaving(false);
    if (!error && data) {
      setNewForm({ name: "", category: "inne", total_amount_pln: "", notes: "" });
      setShowNew(false);
      await load();
      setSelectedId(data.id);
    }
  }

  const filtered = creditors.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return c.name.toLowerCase().includes(s) || (c.notes ?? "").toLowerCase().includes(s);
  });

  const openTotal = creditors
    .filter((c) => c.status !== "splacone")
    .reduce((sum, c) => sum + Number(c.total_amount_pln || 0), 0);
  const overdueCount = creditors.filter((c) => c.next_action_date && c.next_action_date < todayStr() && c.status !== "splacone").length;
  const escalatedCount = creditors.filter((c) => c.status === "eskalacja_windykacja").length;
  const paidCount = creditors.filter((c) => c.status === "splacone").length;

  return (
    <div className="space-y-5 relative">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Windykacja — negocjacje z wierzycielami</h1>
          <p className="text-slate-500 text-sm mt-1">
            {creditors.length} wierzycieli · {fmtPLN(openTotal)} wciąż otwarte
            {overdueCount > 0 && <span className="text-red-600 font-medium"> · {overdueCount} zaległych działań</span>}
            {escalatedCount > 0 && <span className="text-red-600 font-medium"> · {escalatedCount} w windykacji</span>}
            {paidCount > 0 && <span className="text-emerald-600 font-medium"> · {paidCount} spłaconych</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <AccountMenu session={session} />
          <button className="btn-primary" onClick={() => setShowNew((v) => !v)}>
            + Nowy wierzyciel
          </button>
        </div>
      </div>

      {/* Nowy wierzyciel */}
      {showNew && (
        <div className="card space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="md:col-span-2">
              <label className="label">Nazwa wierzyciela *</label>
              <input className="input-field" value={newForm.name}
                onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className="label">Kategoria</label>
              <select className="input-field bg-white" value={newForm.category}
                onChange={(e) => setNewForm((f) => ({ ...f, category: e.target.value as CreditorCategory }))}>
                {(Object.keys(CATEGORY_LABELS) as CreditorCategory[]).map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Kwota (PLN)</label>
              <input className="input-field" inputMode="decimal" value={newForm.total_amount_pln}
                onChange={(e) => setNewForm((f) => ({ ...f, total_amount_pln: e.target.value }))} />
            </div>
            <div className="md:col-span-4">
              <label className="label">Notatki</label>
              <input className="input-field" value={newForm.notes}
                onChange={(e) => setNewForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={saving || !newForm.name.trim()} onClick={handleAddCreditor}>
              {saving ? "Zapisuję…" : "Zapisz wierzyciela"}
            </button>
            <button className="btn-secondary" onClick={() => setShowNew(false)}>Anuluj</button>
          </div>
        </div>
      )}

      {/* Filtry */}
      <div className="card p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="label">Szukaj</label>
            <input className="input-field" placeholder="Nazwa, notatki…"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input-field bg-white" value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | CreditorStatus)}>
              <option value="all">Wszystkie</option>
              {(Object.keys(STATUS_LABELS) as CreditorStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Lista + panel szczegółów */}
      <div className="flex gap-5 flex-wrap items-start">
        <div className="flex-1 min-w-[340px] card p-0 overflow-hidden">
          {loading ? (
            <div className="p-6 text-slate-400 text-sm">Ładowanie…</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-slate-400 text-sm text-center">Brak wierzycieli</div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto">
              {filtered.map((c) => {
                const badge = nextActionBadge(c.status === "splacone" ? null : c.next_action_date);
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                      selectedId === c.id ? "bg-blue-50" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800 text-sm">
                        {c.name} {c.contract_terminated && c.status !== "splacone" && <span title="Umowa wypowiedziana">⚠️</span>}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[c.status]}`}>
                        {STATUS_LABELS[c.status]}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
                      <span className="font-mono">{fmtPLN(Number(c.total_amount_pln))}</span>
                      <span>{CATEGORY_LABELS[c.category]}</span>
                    </div>
                    {c.status !== "splacone" && (
                      <div className={`text-xs mt-1.5 inline-block px-2 py-0.5 rounded ${badge.cls}`}>
                        {badge.text}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedId && (
          <div className="flex-1 min-w-[360px]">
            <CreditorDetail
              creditorId={selectedId}
              session={session}
              profiles={profiles}
              onClose={() => setSelectedId(null)}
              onChanged={load}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PANEL SZCZEGÓŁÓW WIERZYCIELA
// ══════════════════════════════════════════════════════════════
function CreditorDetail({
  creditorId, session, profiles, onClose, onChanged,
}: { creditorId: string; session: Session; profiles: Record<string, Profile>; onClose: () => void; onChanged: () => void }) {
  const [creditor, setCreditor] = useState<Creditor | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<Partial<Creditor>>({});
  const [saving, setSaving] = useState(false);

  const [events, setEvents] = useState<CreditorEvent[]>([]);
  const [evType, setEvType] = useState<EventType>("call");
  const [evDesc, setEvDesc] = useState("");
  const [evAmount, setEvAmount] = useState("");
  const [evNextDate, setEvNextDate] = useState("");
  const [evStatusAfter, setEvStatusAfter] = useState<CreditorStatus | "">("");
  const [savingEv, setSavingEv] = useState(false);

  const [contacts, setContacts] = useState<CreditorContact[]>([]);
  const [showContactForm, setShowContactForm] = useState(false);
  const [contactForm, setContactForm] = useState({ id: "", name: "", role: "", phone: "", email: "", notes: "" });
  const [savingContact, setSavingContact] = useState(false);

  const load = useCallback(async () => {
    const [{ data: c }, { data: evs }, { data: cts }] = await Promise.all([
      supabase.from("creditors").select("*").eq("id", creditorId).single(),
      supabase.from("creditor_events").select("*").eq("creditor_id", creditorId).order("event_date", { ascending: false }),
      supabase.from("creditor_contacts").select("*").eq("creditor_id", creditorId).order("created_at", { ascending: true }),
    ]);
    setCreditor(c ?? null);
    setForm(c ?? {});
    setEvents(evs ?? []);
    setContacts(cts ?? []);
    setEditMode(false);
  }, [creditorId]);

  useEffect(() => { load(); }, [load]);

  async function saveCreditor() {
    if (!creditor) return;
    setSaving(true);
    await supabase.from("creditors").update({
      name: form.name,
      category: form.category,
      total_amount_pln: form.total_amount_pln,
      status: form.status,
      original_due_date: form.original_due_date || null,
      contract_terminated: form.contract_terminated ?? false,
      next_action_date: form.next_action_date || null,
      notes: form.notes || null,
      updated_at: new Date().toISOString(),
    }).eq("id", creditorId);
    setSaving(false);
    await load();
    onChanged();
  }

  async function addEvent() {
    if (!evDesc.trim() && !evNextDate && evType !== "payment") return;
    setSavingEv(true);
    await supabase.from("creditor_events").insert({
      creditor_id: creditorId,
      event_type: evType,
      event_date: todayStr(),
      description: evDesc || null,
      amount_pln: evType === "payment" && evAmount ? parseFloat(evAmount.replace(",", ".")) : null,
      status_after: evType === "status_change" && evStatusAfter ? evStatusAfter : null,
      next_action_date: evNextDate || null,
      created_by: session.user.id,
    });
    setEvDesc(""); setEvAmount(""); setEvNextDate(""); setEvStatusAfter(""); setEvType("call");
    setSavingEv(false);
    await load();
    onChanged();
  }

  async function saveContact() {
    if (!contactForm.name.trim()) return;
    setSavingContact(true);
    if (contactForm.id) {
      await supabase.from("creditor_contacts").update({
        name: contactForm.name, role: contactForm.role || null, phone: contactForm.phone || null,
        email: contactForm.email || null, notes: contactForm.notes || null,
      }).eq("id", contactForm.id);
    } else {
      await supabase.from("creditor_contacts").insert({
        creditor_id: creditorId, name: contactForm.name, role: contactForm.role || null,
        phone: contactForm.phone || null, email: contactForm.email || null, notes: contactForm.notes || null,
      });
    }
    setContactForm({ id: "", name: "", role: "", phone: "", email: "", notes: "" });
    setShowContactForm(false);
    setSavingContact(false);
    await load();
  }

  async function deleteContact(id: string) {
    if (!confirm("Usunąć ten kontakt?")) return;
    await supabase.from("creditor_contacts").delete().eq("id", id);
    await load();
  }

  function editContact(c: CreditorContact) {
    setContactForm({ id: c.id, name: c.name ?? "", role: c.role ?? "", phone: c.phone ?? "", email: c.email ?? "", notes: c.notes ?? "" });
    setShowContactForm(true);
  }

  if (!creditor) return <div className="card text-sm text-slate-400">Ładowanie…</div>;

  return (
    <div className="card space-y-5">
      {/* Nagłówek */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">{creditor.name}</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[creditor.status]}`}>
            {STATUS_LABELS[creditor.status]}
          </span>
          {creditor.contract_terminated && creditor.status !== "splacone" && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 ml-1.5">Umowa wypowiedziana</span>
          )}
          {creditor.assigned_to && (
            <div className="text-xs text-slate-400 mt-1">
              Prowadzi: {profiles[creditor.assigned_to]?.display_name ?? profiles[creditor.assigned_to]?.email ?? "—"}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {!editMode && (
            <button className="text-xs text-blue-600 hover:underline" onClick={() => setEditMode(true)}>Edytuj</button>
          )}
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* Dane wierzyciela */}
      {editMode ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Nazwa</label>
              <input className="input-field" value={form.name ?? ""} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
            <div><label className="label">Kategoria</label>
              <select className="input-field bg-white" value={form.category ?? "inne"} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as CreditorCategory }))}>
                {(Object.keys(CATEGORY_LABELS) as CreditorCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select></div>
            <div><label className="label">Kwota (PLN)</label>
              <input className="input-field" inputMode="decimal" value={form.total_amount_pln ?? ""} onChange={(e) => setForm((f) => ({ ...f, total_amount_pln: e.target.value ? Number(e.target.value) : 0 }))} /></div>
            <div><label className="label">Status</label>
              <select className="input-field bg-white" value={form.status ?? "otwarte"} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as CreditorStatus }))}>
                {(Object.keys(STATUS_LABELS) as CreditorStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select></div>
            <div><label className="label">Termin płatności (pierwotny)</label>
              <input type="date" className="input-field" value={form.original_due_date ?? ""} onChange={(e) => setForm((f) => ({ ...f, original_due_date: e.target.value }))} /></div>
            <div><label className="label">Kolejny kontakt / termin decyzji</label>
              <input type="date" className="input-field" value={form.next_action_date ?? ""} onChange={(e) => setForm((f) => ({ ...f, next_action_date: e.target.value }))} /></div>
            <div className="col-span-2 flex items-center gap-2 pt-1">
              <input type="checkbox" id="terminated" checked={form.contract_terminated ?? false}
                onChange={(e) => setForm((f) => ({ ...f, contract_terminated: e.target.checked }))} />
              <label htmlFor="terminated" className="text-sm text-slate-700">Umowa formalnie wypowiedziana</label>
            </div>
            <div className="col-span-2"><label className="label">Notatki</label>
              <textarea className="input-field" rows={2} value={form.notes ?? ""} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={saving} onClick={saveCreditor}>{saving ? "Zapisuję…" : "Zapisz"}</button>
            <button className="btn-secondary" onClick={() => { setEditMode(false); setForm(creditor); }}>Anuluj</button>
          </div>
        </div>
      ) : (
        <div className="text-sm space-y-1 text-slate-600">
          <div className="font-mono text-base text-slate-800">{fmtPLN(Number(creditor.total_amount_pln))}</div>
          <div>Kategoria: {CATEGORY_LABELS[creditor.category]}</div>
          {creditor.original_due_date && <div>Pierwotny termin: {creditor.original_due_date}</div>}
          {creditor.next_action_date && creditor.status !== "splacone" && <div>Kolejny kontakt: {creditor.next_action_date}</div>}
          {creditor.notes && <div className="text-slate-500 mt-1">{creditor.notes}</div>}
        </div>
      )}

      {/* Kontakty */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Osoby kontaktowe</h3>
          <button className="text-xs text-blue-600 hover:underline"
            onClick={() => { setContactForm({ id: "", name: "", role: "", phone: "", email: "", notes: "" }); setShowContactForm((v) => !v); }}>
            + Dodaj kontakt
          </button>
        </div>
        {showContactForm && (
          <div className="bg-slate-50 rounded-lg p-3 space-y-2 mb-3">
            <div className="grid grid-cols-2 gap-2">
              <input className="input-field" placeholder="Imię i nazwisko" value={contactForm.name}
                onChange={(e) => setContactForm((f) => ({ ...f, name: e.target.value }))} />
              <input className="input-field" placeholder="Rola (np. windykator)" value={contactForm.role}
                onChange={(e) => setContactForm((f) => ({ ...f, role: e.target.value }))} />
              <input className="input-field" placeholder="Telefon" value={contactForm.phone}
                onChange={(e) => setContactForm((f) => ({ ...f, phone: e.target.value }))} />
              <input className="input-field" placeholder="Email" value={contactForm.email}
                onChange={(e) => setContactForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <input className="input-field" placeholder="Uwagi" value={contactForm.notes}
              onChange={(e) => setContactForm((f) => ({ ...f, notes: e.target.value }))} />
            <div className="flex gap-2">
              <button className="btn-primary text-sm" disabled={savingContact} onClick={saveContact}>
                {savingContact ? "Zapisuję…" : "Zapisz kontakt"}
              </button>
              <button className="btn-secondary text-sm" onClick={() => setShowContactForm(false)}>Anuluj</button>
            </div>
          </div>
        )}
        {contacts.length === 0 ? (
          <div className="text-sm text-slate-400">Brak zapisanych kontaktów</div>
        ) : (
          <div className="space-y-2">
            {contacts.map((c) => (
              <div key={c.id} className="text-sm bg-slate-50 rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-800">{c.name}{c.role ? ` — ${c.role}` : ""}</span>
                  <div className="flex gap-2 text-xs">
                    <button className="text-blue-600 hover:underline" onClick={() => editContact(c)}>Edytuj</button>
                    <button className="text-red-500 hover:underline" onClick={() => deleteContact(c.id)}>Usuń</button>
                  </div>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
                  {c.phone && <span>📞 {c.phone}</span>}
                  {c.email && <span>✉️ {c.email}</span>}
                </div>
                {c.notes && <div className="text-xs text-slate-500 mt-1">{c.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Historia negocjacji / progres */}
      <div>
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Historia negocjacji</h3>
        <div className="space-y-2 mb-3">
          <div className="grid grid-cols-2 gap-2">
            <select className="input-field bg-white" value={evType} onChange={(e) => setEvType(e.target.value as EventType)}>
              {(Object.keys(EVENT_LABELS) as EventType[]).map((t) => <option key={t} value={t}>{EVENT_LABELS[t]}</option>)}
            </select>
            <input type="date" className="input-field" value={evNextDate} placeholder="Kolejny kontakt"
              onChange={(e) => setEvNextDate(e.target.value)} title="Data kolejnego kontaktu / decyzji (opcjonalnie)" />
          </div>
          {evType === "payment" && (
            <input className="input-field" inputMode="decimal" placeholder="Kwota zapłacona (PLN)"
              value={evAmount} onChange={(e) => setEvAmount(e.target.value)} />
          )}
          {evType === "status_change" && (
            <select className="input-field bg-white" value={evStatusAfter} onChange={(e) => setEvStatusAfter(e.target.value as CreditorStatus)}>
              <option value="">— wybierz nowy status —</option>
              {(Object.keys(STATUS_LABELS) as CreditorStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          )}
          <textarea className="input-field" rows={2} placeholder="Co ustalono / notatka…" value={evDesc}
            onChange={(e) => setEvDesc(e.target.value)} />
          <button className="btn-secondary text-sm" disabled={savingEv} onClick={addEvent}>
            {savingEv ? "Zapisuję…" : "+ Dodaj wpis"}
          </button>
        </div>
        {events.length === 0 ? (
          <div className="text-sm text-slate-400">Brak zapisanych zdarzeń</div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {events.map((e) => (
              <div key={e.id} className="text-sm bg-slate-50 rounded-lg p-2.5">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>{EVENT_LABELS[e.event_type]}</span>
                  <span>{e.event_date}</span>
                </div>
                {e.description && <div className="text-slate-700 mt-1">{e.description}</div>}
                {e.amount_pln != null && <div className="text-xs text-emerald-700 font-medium mt-1">💰 {fmtPLN(Number(e.amount_pln))}</div>}
                {e.status_after && <div className="text-xs text-slate-500 mt-1">Nowy status: {STATUS_LABELS[e.status_after as CreditorStatus] ?? e.status_after}</div>}
                {e.next_action_date && <div className="text-xs text-blue-600 mt-1">→ kolejny kontakt: {e.next_action_date}</div>}
                {e.created_by && (
                  <div className="text-[11px] text-slate-400 mt-1">
                    {profiles[e.created_by]?.display_name ?? profiles[e.created_by]?.email ?? ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
