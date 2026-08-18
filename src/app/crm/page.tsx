"use client";

import { useState, useEffect, useCallback } from "react";
import type { AuthSession as Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

// ── Typy ─────────────────────────────────────────────────────
type ContactStatus = "prospekt" | "w_negocjacji" | "aktywny" | "stracony";
type ActivityType = "call" | "email" | "meeting" | "note";

interface Contact {
  id: string;
  company_name: string;
  nip: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  routes: string | null;
  status: ContactStatus;
  assigned_to: string | null;
  next_action_date: string | null;
  created_at: string;
  created_by: string | null;
}

interface Profile {
  id: string;
  display_name: string | null;
  email: string | null;
}

interface Activity {
  id: string;
  contact_id: string;
  activity_type: ActivityType;
  activity_date: string;
  description: string | null;
  next_action_date: string | null;
  created_at: string;
}

// Uwaga: celowo BEZ password_encrypted — hasło nigdy nie trafia do klienta
// poza chwilą odszyfrowania przez /api/crm/portal/reveal.
interface Portal {
  id: string;
  contact_id: string;
  portal_name: string | null;
  portal_url: string | null;
  username: string | null;
  notes: string | null;
  created_at: string;
}

const STATUS_LABELS: Record<ContactStatus, string> = {
  prospekt: "Prospekt",
  w_negocjacji: "W negocjacji",
  aktywny: "Aktywny",
  stracony: "Stracony",
};
const STATUS_COLORS: Record<ContactStatus, string> = {
  prospekt: "bg-slate-100 text-slate-600",
  w_negocjacji: "bg-amber-100 text-amber-700",
  aktywny: "bg-emerald-100 text-emerald-700",
  stracony: "bg-red-100 text-red-600",
};
const ACTIVITY_LABELS: Record<ActivityType, string> = {
  call: "📞 Telefon", email: "✉️ E-mail", meeting: "🤝 Spotkanie", note: "📝 Notatka",
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function nextActionBadge(date: string | null) {
  if (!date) return { text: "brak terminu", cls: "bg-slate-100 text-slate-400" };
  const today = todayStr();
  if (date < today) return { text: `${date} (zaległe)`, cls: "bg-red-100 text-red-700 font-semibold" };
  if (date === today) return { text: `${date} (dziś)`, cls: "bg-amber-100 text-amber-700 font-semibold" };
  return { text: date, cls: "bg-blue-50 text-blue-700" };
}

// ══════════════════════════════════════════════════════════════
// BRAMKA LOGOWANIA — dane kontrahentów dostępne tylko po zalogowaniu
// ══════════════════════════════════════════════════════════════
export default function CrmPage() {
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
  return <CrmDashboard session={session} />;
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
    if (error) {
      setErr(error.message === "Invalid login credentials" ? "Nieprawidłowy e-mail lub hasło" : error.message);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-16">
      <div className="card space-y-4">
        <div>
          <h1 className="text-lg font-bold text-slate-900">CRM — logowanie</h1>
          <p className="text-sm text-slate-500 mt-1">
            Dane kontrahentów są dostępne wyłącznie dla zalogowanych handlowców.
          </p>
        </div>
        <form onSubmit={handleLogin} className="space-y-3">
          <div>
            <label className="label">Email</label>
            <input className="input-field" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)} required autoFocus />
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

// ══════════════════════════════════════════════════════════════
// PANEL UŻYTKOWNIKA — konto + zmiana hasła
// ══════════════════════════════════════════════════════════════
function AccountMenu({ session }: { session: Session }) {
  const [showChangePw, setShowChangePw] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function changePassword() {
    if (newPw.length < 8) { setMsg("Hasło musi mieć min. 8 znaków"); return; }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPw });
    setSaving(false);
    if (error) setMsg(`Błąd: ${error.message}`);
    else { setMsg("✓ Hasło zmienione"); setNewPw(""); setTimeout(() => setShowChangePw(false), 1200); }
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-slate-500">{session.user.email}</span>
      <button className="text-blue-600 hover:underline" onClick={() => { setShowChangePw((v) => !v); setMsg(null); }}>
        Zmień hasło
      </button>
      <button className="text-slate-400 hover:text-slate-700" onClick={() => supabase.auth.signOut()}>
        Wyloguj
      </button>
      {showChangePw && (
        <div className="absolute right-6 top-14 z-10 card p-4 w-72 space-y-2">
          <label className="label">Nowe hasło</label>
          <input type="password" className="input-field" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          {msg && <div className={`text-xs ${msg.startsWith("✓") ? "text-emerald-600" : "text-red-600"}`}>{msg}</div>}
          <button className="btn-primary text-sm" disabled={saving} onClick={changePassword}>
            {saving ? "Zapisuję…" : "Zapisz nowe hasło"}
          </button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD CRM (tylko dla zalogowanych)
// ══════════════════════════════════════════════════════════════
function CrmDashboard({ session }: { session: Session }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ContactStatus>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ company_name: "", nip: "", contact_person: "", phone: "", email: "", routes: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("crm_contacts")
      .select("*")
      .order("next_action_date", { ascending: true, nullsFirst: false })
      .order("company_name", { ascending: true });
    setContacts(data ?? []);
    setLoading(false);
  }, []);

  const loadProfiles = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id,display_name,email");
    const map: Record<string, Profile> = {};
    (data ?? []).forEach((p: Profile) => { map[p.id] = p; });
    setProfiles(map);
  }, []);

  useEffect(() => { load(); loadProfiles(); }, [load, loadProfiles]);

  async function handleAddContact() {
    if (!newForm.company_name.trim()) return;
    setSaving(true);
    const myName = profiles[session.user.id]?.display_name ?? session.user.email ?? "";
    const { data, error } = await supabase
      .from("crm_contacts")
      .insert({
        company_name: newForm.company_name.trim(),
        nip: newForm.nip || null,
        contact_person: newForm.contact_person || null,
        phone: newForm.phone || null,
        email: newForm.email || null,
        routes: newForm.routes || null,
        status: "prospekt",
        created_by: session.user.id,
        assigned_to: myName || null,
      })
      .select("id")
      .single();
    setSaving(false);
    if (!error && data) {
      setNewForm({ company_name: "", nip: "", contact_person: "", phone: "", email: "", routes: "" });
      setShowNew(false);
      await load();
      setSelectedId(data.id);
    }
  }

  const filtered = contacts.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      c.company_name.toLowerCase().includes(s) ||
      (c.contact_person ?? "").toLowerCase().includes(s) ||
      (c.nip ?? "").toLowerCase().includes(s) ||
      (c.routes ?? "").toLowerCase().includes(s)
    );
  });

  const overdueCount = contacts.filter((c) => c.next_action_date && c.next_action_date < todayStr()).length;

  return (
    <div className="space-y-5 relative">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">CRM — Pozyskiwanie klientów</h1>
          <p className="text-slate-500 text-sm mt-1">
            {contacts.length} kontaktów
            {overdueCount > 0 && (
              <span className="text-red-600 font-medium"> · {overdueCount} zaległych działań</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <AccountMenu session={session} />
          <button className="btn-primary" onClick={() => setShowNew((v) => !v)}>
            + Nowy kontakt
          </button>
        </div>
      </div>

      {/* Nowy kontakt */}
      {showNew && (
        <div className="card space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="label">Nazwa firmy *</label>
              <input className="input-field" value={newForm.company_name}
                onChange={(e) => setNewForm((f) => ({ ...f, company_name: e.target.value }))} />
            </div>
            <div>
              <label className="label">NIP</label>
              <input className="input-field" value={newForm.nip}
                onChange={(e) => setNewForm((f) => ({ ...f, nip: e.target.value }))} />
            </div>
            <div>
              <label className="label">Osoba kontaktowa</label>
              <input className="input-field" value={newForm.contact_person}
                onChange={(e) => setNewForm((f) => ({ ...f, contact_person: e.target.value }))} />
            </div>
            <div>
              <label className="label">Telefon</label>
              <input className="input-field" value={newForm.phone}
                onChange={(e) => setNewForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input-field" value={newForm.email}
                onChange={(e) => setNewForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div>
              <label className="label">Trasy</label>
              <input className="input-field" placeholder="np. ES / GB" value={newForm.routes}
                onChange={(e) => setNewForm((f) => ({ ...f, routes: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={saving || !newForm.company_name.trim()} onClick={handleAddContact}>
              {saving ? "Zapisuję…" : "Zapisz kontakt"}
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
            <input className="input-field" placeholder="Firma, osoba, NIP, trasa…"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input-field bg-white" value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | ContactStatus)}>
              <option value="all">Wszystkie</option>
              {(Object.keys(STATUS_LABELS) as ContactStatus[]).map((s) => (
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
            <div className="p-6 text-slate-400 text-sm text-center">Brak kontaktów</div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto">
              {filtered.map((c) => {
                const badge = nextActionBadge(c.next_action_date);
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                      selectedId === c.id ? "bg-blue-50" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800 text-sm">{c.company_name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[c.status]}`}>
                        {STATUS_LABELS[c.status]}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
                      {c.contact_person && <span>{c.contact_person}</span>}
                      {c.routes && <span>🛣️ {c.routes}</span>}
                    </div>
                    <div className={`text-xs mt-1.5 inline-block px-2 py-0.5 rounded ${badge.cls}`}>
                      {badge.text}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedId && (
          <div className="flex-1 min-w-[360px]">
            <ContactDetail
              contactId={selectedId}
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
// PANEL SZCZEGÓŁÓW KONTAKTU
// ══════════════════════════════════════════════════════════════
function ContactDetail({
  contactId, session, profiles, onClose, onChanged,
}: { contactId: string; session: Session; profiles: Record<string, Profile>; onClose: () => void; onChanged: () => void }) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<Partial<Contact>>({});
  const [saving, setSaving] = useState(false);

  const [activities, setActivities] = useState<Activity[]>([]);
  const [actType, setActType] = useState<ActivityType>("call");
  const [actDesc, setActDesc] = useState("");
  const [actNextDate, setActNextDate] = useState("");
  const [savingAct, setSavingAct] = useState(false);

  const [portals, setPortals] = useState<Portal[]>([]);
  const [showPortalForm, setShowPortalForm] = useState(false);
  const [portalForm, setPortalForm] = useState({ id: "", portal_name: "", portal_url: "", username: "", password: "", notes: "" });
  const [savingPortal, setSavingPortal] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: c }, { data: acts }, { data: pts }] = await Promise.all([
      supabase.from("crm_contacts").select("*").eq("id", contactId).single(),
      supabase.from("crm_activities").select("*").eq("contact_id", contactId).order("activity_date", { ascending: false }),
      supabase.from("crm_tender_portals").select("id,contact_id,portal_name,portal_url,username,notes,created_at").eq("contact_id", contactId),
    ]);
    setContact(c ?? null);
    setForm(c ?? {});
    setActivities(acts ?? []);
    setPortals(pts ?? []);
    setEditMode(false);
    setRevealed({});
  }, [contactId]);

  useEffect(() => { load(); }, [load]);

  async function saveContact() {
    if (!contact) return;
    setSaving(true);
    await supabase.from("crm_contacts").update({
      company_name: form.company_name,
      nip: form.nip || null,
      contact_person: form.contact_person || null,
      phone: form.phone || null,
      email: form.email || null,
      routes: form.routes || null,
      status: form.status,
      assigned_to: form.assigned_to || null,
      updated_at: new Date().toISOString(),
    }).eq("id", contactId);
    setSaving(false);
    await load();
    onChanged();
  }

  async function addActivity() {
    if (!actDesc.trim() && !actNextDate) return;
    setSavingAct(true);
    await supabase.from("crm_activities").insert({
      contact_id: contactId,
      activity_type: actType,
      activity_date: todayStr(),
      description: actDesc || null,
      next_action_date: actNextDate || null,
    });
    if (actNextDate) {
      await supabase.from("crm_contacts").update({ next_action_date: actNextDate }).eq("id", contactId);
    }
    setActDesc(""); setActNextDate(""); setActType("call");
    setSavingAct(false);
    await load();
    onChanged();
  }

  async function savePortal() {
    if (!portalForm.portal_name.trim() && !portalForm.portal_url.trim()) return;
    setSavingPortal(true);
    try {
      const res = await fetch("/api/crm/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          id: portalForm.id || undefined,
          contact_id: contactId,
          portal_name: portalForm.portal_name,
          portal_url: portalForm.portal_url,
          username: portalForm.username,
          password: portalForm.password || undefined,
          notes: portalForm.notes,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setPortalForm({ id: "", portal_name: "", portal_url: "", username: "", password: "", notes: "" });
      setShowPortalForm(false);
      await load();
    } catch (e) {
      alert(`Błąd zapisu: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingPortal(false);
    }
  }

  async function deletePortal(id: string) {
    if (!confirm("Usunąć ten login?")) return;
    await fetch("/api/crm/portal", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ id }),
    });
    await load();
  }

  async function reveal(id: string) {
    if (revealed[id]) {
      setRevealed((r) => { const n = { ...r }; delete n[id]; return n; });
      return;
    }
    setRevealing(id);
    try {
      const res = await fetch("/api/crm/portal/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setRevealed((r) => ({ ...r, [id]: json.password ?? "(brak hasła)" }));
    } catch (e) {
      alert(`Błąd odczytu hasła: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRevealing(null);
    }
  }

  function editPortal(p: Portal) {
    setPortalForm({ id: p.id, portal_name: p.portal_name ?? "", portal_url: p.portal_url ?? "", username: p.username ?? "", password: "", notes: p.notes ?? "" });
    setShowPortalForm(true);
  }

  if (!contact) return <div className="card text-sm text-slate-400">Ładowanie…</div>;

  return (
    <div className="card space-y-5">
      {/* Nagłówek */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">{contact.company_name}</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[contact.status]}`}>
            {STATUS_LABELS[contact.status]}
          </span>
          {contact.created_by && (
            <div className="text-xs text-slate-400 mt-1">
              Dodane przez: {profiles[contact.created_by]?.display_name ?? profiles[contact.created_by]?.email ?? "—"}
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

      {/* Dane kontaktu */}
      {editMode ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Nazwa firmy</label>
              <input className="input-field" value={form.company_name ?? ""} onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))} /></div>
            <div><label className="label">NIP</label>
              <input className="input-field" value={form.nip ?? ""} onChange={(e) => setForm((f) => ({ ...f, nip: e.target.value }))} /></div>
            <div><label className="label">Osoba kontaktowa</label>
              <input className="input-field" value={form.contact_person ?? ""} onChange={(e) => setForm((f) => ({ ...f, contact_person: e.target.value }))} /></div>
            <div><label className="label">Telefon</label>
              <input className="input-field" value={form.phone ?? ""} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></div>
            <div><label className="label">Email</label>
              <input className="input-field" value={form.email ?? ""} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></div>
            <div><label className="label">Trasy</label>
              <input className="input-field" value={form.routes ?? ""} onChange={(e) => setForm((f) => ({ ...f, routes: e.target.value }))} /></div>
            <div><label className="label">Status</label>
              <select className="input-field bg-white" value={form.status ?? "prospekt"} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as ContactStatus }))}>
                {(Object.keys(STATUS_LABELS) as ContactStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select></div>
            <div><label className="label">Handlowiec</label>
              <input className="input-field" value={form.assigned_to ?? ""} onChange={(e) => setForm((f) => ({ ...f, assigned_to: e.target.value }))} /></div>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={saving} onClick={saveContact}>{saving ? "Zapisuję…" : "Zapisz"}</button>
            <button className="btn-secondary" onClick={() => { setEditMode(false); setForm(contact); }}>Anuluj</button>
          </div>
        </div>
      ) : (
        <div className="text-sm space-y-1 text-slate-600">
          {contact.contact_person && <div>👤 {contact.contact_person}</div>}
          {contact.phone && <div>📞 {contact.phone}</div>}
          {contact.email && <div>✉️ {contact.email}</div>}
          {contact.nip && <div>NIP: {contact.nip}</div>}
          {contact.routes && <div>🛣️ {contact.routes}</div>}
          {contact.assigned_to && <div>Handlowiec: {contact.assigned_to}</div>}
        </div>
      )}

      {/* Historia działań */}
      <div>
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Historia działań</h3>
        <div className="space-y-2 mb-3">
          <div className="grid grid-cols-2 gap-2">
            <select className="input-field bg-white" value={actType} onChange={(e) => setActType(e.target.value as ActivityType)}>
              {(Object.keys(ACTIVITY_LABELS) as ActivityType[]).map((t) => <option key={t} value={t}>{ACTIVITY_LABELS[t]}</option>)}
            </select>
            <input type="date" className="input-field" value={actNextDate} placeholder="Kolejny kontakt"
              onChange={(e) => setActNextDate(e.target.value)} title="Data kolejnego kontaktu (opcjonalnie)" />
          </div>
          <textarea className="input-field" rows={2} placeholder="Co ustalono / notatka…" value={actDesc}
            onChange={(e) => setActDesc(e.target.value)} />
          <button className="btn-secondary text-sm" disabled={savingAct} onClick={addActivity}>
            {savingAct ? "Zapisuję…" : "+ Dodaj wpis"}
          </button>
        </div>
        {activities.length === 0 ? (
          <div className="text-sm text-slate-400">Brak zapisanych działań</div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {activities.map((a) => (
              <div key={a.id} className="text-sm bg-slate-50 rounded-lg p-2.5">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>{ACTIVITY_LABELS[a.activity_type]}</span>
                  <span>{a.activity_date}</span>
                </div>
                {a.description && <div className="text-slate-700 mt-1">{a.description}</div>}
                {a.next_action_date && (
                  <div className="text-xs text-blue-600 mt-1">→ kolejny kontakt: {a.next_action_date}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Loginy do systemów przetargowych */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Systemy przetargowe</h3>
          <button className="text-xs text-blue-600 hover:underline"
            onClick={() => { setPortalForm({ id: "", portal_name: "", portal_url: "", username: "", password: "", notes: "" }); setShowPortalForm((v) => !v); }}>
            + Dodaj login
          </button>
        </div>

        {showPortalForm && (
          <div className="bg-slate-50 rounded-lg p-3 space-y-2 mb-3">
            <input className="input-field" placeholder="Nazwa systemu (np. TransEU, Trans.eu)"
              value={portalForm.portal_name} onChange={(e) => setPortalForm((f) => ({ ...f, portal_name: e.target.value }))} />
            <input className="input-field" placeholder="Adres URL"
              value={portalForm.portal_url} onChange={(e) => setPortalForm((f) => ({ ...f, portal_url: e.target.value }))} />
            <div className="grid grid-cols-2 gap-2">
              <input className="input-field" placeholder="Login" value={portalForm.username}
                onChange={(e) => setPortalForm((f) => ({ ...f, username: e.target.value }))} />
              <input className="input-field" type="password" placeholder={portalForm.id ? "Nowe hasło (zostaw puste bez zmian)" : "Hasło"}
                value={portalForm.password} onChange={(e) => setPortalForm((f) => ({ ...f, password: e.target.value }))} />
            </div>
            <input className="input-field" placeholder="Uwagi" value={portalForm.notes}
              onChange={(e) => setPortalForm((f) => ({ ...f, notes: e.target.value }))} />
            <div className="flex gap-2">
              <button className="btn-primary text-sm" disabled={savingPortal} onClick={savePortal}>
                {savingPortal ? "Zapisuję…" : "Zapisz login"}
              </button>
              <button className="btn-secondary text-sm" onClick={() => setShowPortalForm(false)}>Anuluj</button>
            </div>
          </div>
        )}

        {portals.length === 0 ? (
          <div className="text-sm text-slate-400">Brak zapisanych loginów</div>
        ) : (
          <div className="space-y-2">
            {portals.map((p) => (
              <div key={p.id} className="text-sm bg-slate-50 rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-800">{p.portal_name || p.portal_url || "System"}</span>
                  <div className="flex gap-2 text-xs">
                    <button className="text-blue-600 hover:underline" onClick={() => editPortal(p)}>Edytuj</button>
                    <button className="text-red-500 hover:underline" onClick={() => deletePortal(p.id)}>Usuń</button>
                  </div>
                </div>
                {p.portal_url && <div className="text-xs text-slate-500 truncate">{p.portal_url}</div>}
                <div className="text-xs text-slate-600 mt-1 flex items-center gap-2">
                  <span>Login: {p.username || "—"}</span>
                  <span className="text-slate-400">·</span>
                  <span className="font-mono">
                    {revealed[p.id] ? revealed[p.id] : "••••••••"}
                  </span>
                  <button
                    className="text-blue-600 hover:underline"
                    disabled={revealing === p.id}
                    onClick={() => reveal(p.id)}
                  >
                    {revealing === p.id ? "…" : revealed[p.id] ? "Ukryj" : "Pokaż"}
                  </button>
                </div>
                {p.notes && <div className="text-xs text-slate-500 mt-1">{p.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
