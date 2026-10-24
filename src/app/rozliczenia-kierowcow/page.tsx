"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { AuthSession as Session } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import {
  type Person, type Rate, type Period, type Line, type Entry, type PayrollRole, type PeriodStatus,
  type EntryKind, type ImportRow, type Issue,
  STATUS_LABELS, DEFAULT_EUR_PLN, CREDIT_CATEGORIES, DEDUCTION_CATEGORIES,
  round2, daysInMonth, periodLabel, fullName, rateFor, computeLine, validatePeriod,
  buildOzarWorkbook, ozarFileName, parseSettlementWorkbook,
} from "@/lib/payroll";

// ══════════════════════════════════════════════════════════════
// /rozliczenia-kierowcow — miesięczne wyliczenie wypłat netto kierowców
// dla Ozar Trans (płatnik). Wpisujący (editor) uzupełniają dni pracy,
// urlopy, chorobowe oraz uznania i potrącenia; zatwierdzający (approver)
// widzi stawki i kwoty, zatwierdza i generuje plik w układzie
// "wypłaty kierowcy <miesiąc>". Role i ograniczenia są w bazie
// (migracja 030_driver_payroll.sql), nie tylko w interfejsie.
// ══════════════════════════════════════════════════════════════

interface Profile { id: string; display_name: string | null; email: string | null }
interface AuditRow { id: number; at: string; user_id: string | null; table_name: string; action: string; old_row: Record<string, unknown> | null; new_row: Record<string, unknown> | null }

const fmtPln = (n: number | null) => n == null ? "—" : n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDateTime = (s: string | null) => (s ? new Date(s).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "—");
const num = (s: string) => { const n = parseFloat(s.replace(",", ".")); return isNaN(n) ? null : n; };
const STATUS_COLORS: Record<PeriodStatus, string> = {
  otwarty: "bg-amber-100 text-amber-700",
  zgloszony: "bg-blue-100 text-blue-700",
  zatwierdzony: "bg-emerald-100 text-emerald-700",
  wyslany: "bg-slate-200 text-slate-700",
};
const firstOf = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;

export default function RozliczeniaPage() {
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
        <h1 className="text-lg font-bold text-slate-900 mb-1">Rozliczenia kierowców</h1>
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

type Tab = "miesiac" | "osoby" | "import" | "dziennik";

function Dashboard({ session }: { session: Session }) {
  const [roles, setRoles] = useState<PayrollRole[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [frozen, setFrozen] = useState<Record<string, { day_rate: number; leave_rate: number }>>({});
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("miesiac");
  const [busy, setBusy] = useState(false);

  const isApprover = roles.includes("approver");
  const isEditor = roles.includes("editor") || isApprover;
  const period = periods.find((p) => p.id === periodId) ?? null;

  const loadBase = useCallback(async () => {
    setLoading(true);
    const r = await supabase.from("payroll_roles").select("role").eq("user_id", session.user.id);
    const myRoles = ((r.data ?? []) as { role: PayrollRole }[]).map((x) => x.role);
    setRoles(myRoles); setRolesLoaded(true);
    if (r.error) {
      setLoadError(r.error.message.includes("schema cache") || r.error.message.includes("does not exist")
        ? "Brak tabel modułu — uruchom migrację 030_driver_payroll.sql w Supabase Studio." : r.error.message);
      setLoading(false); return;
    }
    if (myRoles.length === 0) { setLoading(false); return; }
    const approver = myRoles.includes("approver");
    const [pe, pr, rt, prof] = await Promise.all([
      supabase.from("payroll_people").select("*").order("last_name"),
      supabase.from("payroll_periods").select("*").order("year", { ascending: false }).order("month", { ascending: false }),
      approver ? supabase.from("payroll_rates").select("*") : Promise.resolve({ data: [], error: null }),
      supabase.from("profiles").select("id,display_name,email"),
    ]);
    const err = pe.error ?? pr.error ?? rt.error;
    setLoadError(err ? err.message : null);
    setPeople((pe.data ?? []) as Person[]);
    setRates(((rt.data ?? []) as Rate[]).map((x) => ({ ...x, day_rate: Number(x.day_rate), leave_rate: Number(x.leave_rate) })));
    const per = (pr.data ?? []) as Period[];
    setPeriods(per);
    setPeriodId((cur) => (cur && per.some((p) => p.id === cur) ? cur : per[0]?.id ?? null));
    const pm: Record<string, Profile> = {};
    ((prof.data ?? []) as Profile[]).forEach((x) => (pm[x.id] = x));
    setProfiles(pm);
    setLoading(false);
  }, [session.user.id]);
  useEffect(() => { loadBase(); }, [loadBase]);

  const loadPeriod = useCallback(async () => {
    if (!periodId) { setLines([]); setEntries([]); setFrozen({}); return; }
    const [l, e, fr] = await Promise.all([
      supabase.from("payroll_lines").select("*").eq("period_id", periodId),
      supabase.from("payroll_entries").select("*").eq("period_id", periodId).order("created_at"),
      isApprover ? supabase.from("payroll_period_rates").select("*").eq("period_id", periodId) : Promise.resolve({ data: [], error: null }),
    ]);
    setLines((l.data ?? []) as Line[]);
    setEntries(((e.data ?? []) as Entry[]).map((x) => ({ ...x, amount_orig: Number(x.amount_orig), fx_rate: Number(x.fx_rate), amount_pln: Number(x.amount_pln) })));
    const f: Record<string, { day_rate: number; leave_rate: number }> = {};
    ((fr.data ?? []) as { person_id: string; day_rate: number; leave_rate: number }[]).forEach((x) => (f[x.person_id] = { day_rate: Number(x.day_rate), leave_rate: Number(x.leave_rate) }));
    setFrozen(f);
  }, [periodId, isApprover]);
  useEffect(() => { loadPeriod(); }, [loadPeriod]);

  const rateOf = useCallback((personId: string) => {
    if (!isApprover || !period) return null;
    if ((period.status === "zatwierdzony" || period.status === "wyslany") && frozen[personId]) return frozen[personId];
    const r = rateFor(rates, personId, period.year, period.month);
    return r ? { day_rate: r.day_rate, leave_rate: r.leave_rate } : null;
  }, [isApprover, period, frozen, rates]);

  const issues = useMemo<Issue[]>(() => period
    ? validatePeriod({ period, people, lines, entries, rateOf: isApprover ? rateOf : null }) : [], [period, people, lines, entries, rateOf, isApprover]);
  const nameOf = (id: string | null) => (id ? profiles[id]?.display_name ?? profiles[id]?.email ?? id.slice(0, 8) : "—");

  if (rolesLoaded && roles.length === 0 && !loadError) {
    return (
      <div className="card max-w-lg mx-auto mt-12 text-center">
        <h1 className="text-lg font-bold text-slate-900 mb-2">Rozliczenia kierowców</h1>
        <p className="text-sm text-slate-500">
          Konto {session.user.email} nie ma roli w tym module (wpisujący / zatwierdzający).
          Poproś administratora o dopisanie w tabeli <code className="bg-slate-100 px-1 rounded">payroll_roles</code>.
        </p>
      </div>
    );
  }

  const tabBtn = (t: Tab, label: string) => (
    <button onClick={() => setTab(t)}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === t ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{label}</button>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Rozliczenia kierowców</h1>
          <p className="text-slate-500 text-sm mt-1">
            Wyliczenie wypłat netto dla Ozar Trans · Twoja rola: {roles.map((r) => (r === "approver" ? "zatwierdzający" : "wpisujący")).join(", ") || "—"}
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-500">{session.user.email}</span>
          <button className="text-slate-400 hover:text-slate-700" onClick={() => supabase.auth.signOut()}>Wyloguj</button>
        </div>
      </div>

      {loadError && <div className="card text-sm text-red-600">{loadError}</div>}

      <div className="flex gap-1 border-b border-slate-200 flex-wrap">
        {tabBtn("miesiac", "Miesiąc")}
        {isApprover && tabBtn("osoby", "Osoby i stawki")}
        {isApprover && tabBtn("import", "Import z pliku")}
        {isApprover && tabBtn("dziennik", "Dziennik zmian")}
      </div>

      {loading ? <div className="p-6 text-sm text-slate-400">Ładowanie…</div> : (
        <>
          {tab === "miesiac" && (
            <MonthTab
              session={session} isApprover={isApprover} isEditor={isEditor}
              periods={periods} period={period} setPeriodId={setPeriodId}
              people={people} lines={lines} entries={entries} issues={issues} rateOf={rateOf} rates={rates}
              busy={busy} setBusy={setBusy} nameOf={nameOf}
              reloadBase={loadBase} reloadPeriod={loadPeriod}
            />
          )}
          {tab === "osoby" && isApprover && (
            <PeopleTab people={people} rates={rates} period={period} onChanged={loadBase} />
          )}
          {tab === "import" && isApprover && (
            <ImportTab period={period} people={people} rates={rates} lines={lines} entries={entries}
              onDone={async () => { await loadBase(); await loadPeriod(); }} />
          )}
          {tab === "dziennik" && isApprover && <AuditTab nameOf={nameOf} people={people} />}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Zakładka: Miesiąc
// ══════════════════════════════════════════════════════════════
function MonthTab(props: {
  session: Session; isApprover: boolean; isEditor: boolean;
  periods: Period[]; period: Period | null; setPeriodId: (id: string) => void;
  people: Person[]; lines: Line[]; entries: Entry[]; issues: Issue[];
  rateOf: (personId: string) => { day_rate: number; leave_rate: number } | null; rates: Rate[];
  busy: boolean; setBusy: (b: boolean) => void; nameOf: (id: string | null) => string;
  reloadBase: () => Promise<void>; reloadPeriod: () => Promise<void>;
}) {
  const { session, isApprover, periods, period, people, lines, entries, issues, rateOf, busy, setBusy } = props;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [onlyActive, setOnlyActive] = useState(true);
  const [newYear, setNewYear] = useState(() => new Date().getFullYear());
  const [newMonth, setNewMonth] = useState(() => new Date().getMonth() + 1);

  const dim = period ? daysInMonth(period.year, period.month) : 31;
  const editable = !!period && (period.status === "otwarty" || (period.status === "zgloszony" && isApprover));
  const lineBy = useMemo(() => new Map(lines.map((l) => [l.person_id, l])), [lines]);
  const visible = people.filter((p) => !onlyActive || p.active || lineBy.has(p.id));
  const errors = issues.filter((i) => i.level === "error");
  const issueBy = useMemo(() => {
    const m = new Map<string, Issue[]>();
    issues.forEach((i) => { if (i.personId) m.set(i.personId, [...(m.get(i.personId) ?? []), i]); });
    return m;
  }, [issues]);

  async function openPeriod() {
    if (periods.some((p) => p.year === newYear && p.month === newMonth)) { alert("Ten miesiąc jest już otwarty."); return; }
    setBusy(true);
    const { data, error } = await supabase.from("payroll_periods").insert({ year: newYear, month: newMonth }).select().single();
    setBusy(false);
    if (error) { alert("Nie udało się otworzyć miesiąca: " + error.message); return; }
    await props.reloadBase();
    props.setPeriodId((data as Period).id);
  }

  async function saveDays(person: Person, patch: Partial<Pick<Line, "days_worked" | "days_leave" | "days_sick">>) {
    if (!period) return;
    const cur = lineBy.get(person.id);
    const row = {
      period_id: period.id, person_id: person.id,
      days_worked: cur?.days_worked ?? 0, days_leave: cur?.days_leave ?? 0, days_sick: cur?.days_sick ?? 0, ...patch,
    };
    const { error } = await supabase.from("payroll_lines").upsert(row, { onConflict: "period_id,person_id" });
    if (error) { alert(`${fullName(person)}: ${error.message}`); }
    await props.reloadPeriod();
  }

  async function setStatus(status: PeriodStatus, extra: Record<string, unknown> = {}) {
    if (!period) return;
    setBusy(true);
    const { error } = await supabase.from("payroll_periods").update({ status, ...extra }).eq("id", period.id);
    setBusy(false);
    if (error) { alert("Błąd zmiany statusu: " + error.message); return; }
    await props.reloadBase(); await props.reloadPeriod();
  }
  const submit = () => {
    if (errors.length && !confirm(`Są ${errors.length} błędy do poprawy. Zgłosić mimo to?`)) return;
    setStatus("zgloszony", { submitted_by: session.user.id, submitted_at: new Date().toISOString() });
  };
  async function approve() {
    if (!period) return;
    if (errors.length) { alert(`Nie można zatwierdzić: ${errors.length} błędów (patrz lista poniżej).`); return; }
    if (!confirm("Zatwierdzić miesiąc? Stawki zostaną zamrożone, a edycja zablokowana.")) return;
    setBusy(true);
    const snap = lines.map((l) => ({ l, r: rateOf(l.person_id) })).filter((x) => x.r)
      .map((x) => ({ period_id: period.id, person_id: x.l.person_id, day_rate: x.r!.day_rate, leave_rate: x.r!.leave_rate }));
    if (snap.length) {
      const { error: e1 } = await supabase.from("payroll_period_rates").upsert(snap, { onConflict: "period_id,person_id" });
      if (e1) { setBusy(false); alert("Nie udało się zamrozić stawek: " + e1.message); return; }
    }
    setBusy(false);
    await setStatus("zatwierdzony", { approved_by: session.user.id, approved_at: new Date().toISOString() });
  }
  async function reopen() {
    if (!period) return;
    const wasFinal = period.status === "zatwierdzony" || period.status === "wyslany";
    const msg = wasFinal
      ? "Cofnąć do edycji? Powstanie nowa wersja zestawienia (wersja " + (period.version + 1) + "), a zamrożone stawki zostaną usunięte."
      : "Cofnąć do edycji?";
    if (!confirm(msg)) return;
    if (wasFinal) {
      const { error } = await supabase.from("payroll_period_rates").delete().eq("period_id", period.id);
      if (error) { alert("Błąd: " + error.message); return; }
    }
    await setStatus("otwarty", wasFinal
      ? { version: period.version + 1, approved_by: null, approved_at: null, sent_by: null, sent_at: null }
      : { submitted_by: null, submitted_at: null });
  }
  const markSent = () => {
    if (!confirm("Oznaczyć zestawienie jako wysłane do Ozar?")) return;
    setStatus("wyslany", { sent_by: session.user.id, sent_at: new Date().toISOString() });
  };
  function download(ext: "ods" | "xlsx") {
    if (!period) return;
    try {
      const wb = buildOzarWorkbook({
        period, people, lines, entries, rateOf,
        draft: period.status !== "zatwierdzony" && period.status !== "wyslany",
      });
      XLSX.writeFile(wb, ozarFileName(period, ext), { bookType: ext });
    } catch (e) { alert((e as Error).message); }
  }

  // sumy do paska podsumowania
  const totals = useMemo(() => {
    let days = 0, leave = 0, cred = 0, ded = 0, sum = 0, missing = 0;
    people.forEach((p) => {
      const l = lineBy.get(p.id); if (!l) return;
      const es = entries.filter((e) => e.person_id === p.id);
      const c = computeLine(l, es, rateOf(p.id));
      days += l.days_worked; leave += l.days_leave; cred += c.credits; ded += c.deductions;
      if (c.total == null) missing++; else sum += c.total;
    });
    return { days, leave, cred, ded, sum: round2(sum), missing };
  }, [people, lineBy, entries, rateOf]);

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-3">
        <select className="input-field !w-auto" value={period?.id ?? ""} onChange={(e) => props.setPeriodId(e.target.value)}>
          {periods.length === 0 && <option value="">brak otwartych miesięcy</option>}
          {periods.map((p) => <option key={p.id} value={p.id}>{periodLabel(p.year, p.month)}</option>)}
        </select>
        {period && (
          <>
            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${STATUS_COLORS[period.status]}`}>{STATUS_LABELS[period.status]}</span>
            {period.version > 1 && <span className="text-xs text-slate-500">wersja {period.version}</span>}
            {period.sent_at && <span className="text-xs text-slate-500">wysłano {fmtDateTime(period.sent_at)}</span>}
          </>
        )}
        <div className="flex-1" />
        {period && period.status === "otwarty" && props.isEditor && (
          <button className="btn-primary" disabled={busy} onClick={submit}>Zgłoś do zatwierdzenia</button>
        )}
        {period && period.status === "zgloszony" && isApprover && (
          <>
            <button className="btn-secondary" disabled={busy} onClick={reopen}>Cofnij do edycji</button>
            <button className="btn-primary" disabled={busy} onClick={approve}>Zatwierdź</button>
          </>
        )}
        {period && period.status === "zatwierdzony" && isApprover && (
          <>
            <button className="btn-secondary" disabled={busy} onClick={reopen}>Nowa wersja (odblokuj)</button>
            <button className="btn-primary" disabled={busy} onClick={markSent}>Oznacz jako wysłane do Ozar</button>
          </>
        )}
        {period && period.status === "wyslany" && isApprover && (
          <button className="btn-secondary" disabled={busy} onClick={reopen}>Nowa wersja (odblokuj)</button>
        )}
        {period && isApprover && (
          <>
            <button className="btn-secondary" onClick={() => download("ods")}>Pobierz .ods</button>
            <button className="btn-secondary" onClick={() => download("xlsx")}>Pobierz .xlsx</button>
          </>
        )}
      </div>

      {isApprover && (
        <div className="card flex flex-wrap items-end gap-3">
          <div><label className="label">Otwórz nowy miesiąc</label>
            <div className="flex gap-2">
              <select className="input-field !w-auto" value={newMonth} onChange={(e) => setNewMonth(Number(e.target.value))}>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{periodLabel(2000, i + 1).split(" ")[0]}</option>)}
              </select>
              <input className="input-field !w-24" type="number" value={newYear} onChange={(e) => setNewYear(Number(e.target.value))} />
            </div>
          </div>
          <button className="btn-secondary" disabled={busy} onClick={openPeriod}>Otwórz miesiąc</button>
        </div>
      )}

      {period && (
        <>
          {isApprover && (
            <div className="card grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <Stat label="Dni pracy" value={String(totals.days)} />
              <Stat label="Dni urlopu" value={String(totals.leave)} />
              <Stat label="Uznania / zwroty" value={fmtPln(totals.cred)} />
              <Stat label="Obciążenia" value={fmtPln(totals.ded)} />
              <Stat label="Do wypłaty (netto)" value={fmtPln(totals.sum) + " PLN"} strong warn={totals.missing > 0 ? `${totals.missing} bez stawki` : undefined} />
            </div>
          )}

          <div className="card !p-0 overflow-x-auto">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 text-sm">
              <span className="text-slate-500">{periodLabel(period.year, period.month)} · {dim} dni w miesiącu{editable ? "" : " · tylko podgląd"}</span>
              <label className="flex items-center gap-2 text-slate-500"><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> tylko aktywni</label>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Kierowca</th>
                  <th className="px-2 py-2">Dni pracy</th><th className="px-2 py-2">Urlop</th><th className="px-2 py-2">Chorobowe</th>
                  <th className="px-2 py-2">Razem dni</th>
                  <th className="text-right px-3 py-2">Uznania</th><th className="text-right px-3 py-2">Potrącenia</th>
                  {isApprover && <><th className="text-right px-3 py-2">Stawka</th><th className="text-right px-3 py-2">Do wypłaty</th></>}
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => {
                  const l = lineBy.get(p.id);
                  const es = entries.filter((e) => e.person_id === p.id);
                  const rate = rateOf(p.id);
                  const c = computeLine(l, es, rate);
                  const sum = (l?.days_worked ?? 0) + (l?.days_leave ?? 0) + (l?.days_sick ?? 0);
                  const pIssues = issueBy.get(p.id) ?? [];
                  const hasErr = pIssues.some((i) => i.level === "error");
                  return (
                    <RowBlock key={p.id}>
                      <tr className={`border-t border-slate-100 ${hasErr ? "bg-red-50" : !l ? "bg-amber-50/40" : ""}`}>
                        <td className="px-3 py-1.5 font-medium text-slate-800">{fullName(p)}{!p.active && <span className="ml-2 text-[10px] text-slate-400">nieaktywny</span>}</td>
                        {(["days_worked", "days_leave", "days_sick"] as const).map((f) => (
                          <td key={f} className="px-1 py-1 text-center">
                            <DayInput value={l ? l[f] : null} max={dim} disabled={!editable} onCommit={(v) => saveDays(p, { [f]: v })} />
                          </td>
                        ))}
                        <td className={`px-2 py-1.5 text-center ${sum > dim ? "text-red-600 font-bold" : "text-slate-500"}`}>{l ? sum : "—"}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{c.credits ? fmtPln(c.credits) : "—"}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${c.deductions ? "text-red-600" : ""}`}>{c.deductions ? fmtPln(c.deductions) : "—"}</td>
                        {isApprover && <>
                          <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{rate ? rate.day_rate : <span className="text-red-500">brak</span>}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${c.total != null && c.total < 0 ? "text-red-600" : ""}`}>{l ? fmtPln(c.total) : "—"}</td>
                        </>}
                        <td className="px-3 py-1.5 text-right">
                          <button className="text-blue-600 hover:underline text-xs" onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                            Pozycje ({es.length}){pIssues.length > 0 && <span className={hasErr ? " text-red-600" : " text-amber-600"}> ●</span>}
                          </button>
                        </td>
                      </tr>
                      {expanded === p.id && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={isApprover ? 10 : 8} className="px-4 py-3">
                            <EntriesPanel person={p} period={period} entries={es} editable={editable} issues={pIssues}
                              note={l?.note ?? ""} onNote={async (v) => { await saveDaysNote(p, v); }} onChanged={props.reloadPeriod} />
                          </td>
                        </tr>
                      )}
                    </RowBlock>
                  );
                })}
              </tbody>
            </table>
          </div>

          <IssuesPanel issues={issues} people={people} />
        </>
      )}
      {!period && <div className="card text-sm text-slate-500">{isApprover ? "Otwórz pierwszy miesiąc powyżej." : "Zatwierdzający musi najpierw otworzyć miesiąc."}</div>}
    </div>
  );

  async function saveDaysNote(person: Person, note: string) {
    if (!period) return;
    const cur = lineBy.get(person.id);
    const { error } = await supabase.from("payroll_lines").upsert({
      period_id: period.id, person_id: person.id,
      days_worked: cur?.days_worked ?? 0, days_leave: cur?.days_leave ?? 0, days_sick: cur?.days_sick ?? 0, note: note.trim() || null,
    }, { onConflict: "period_id,person_id" });
    if (error) alert(error.message);
    await props.reloadPeriod();
  }
}

function RowBlock({ children }: { children: React.ReactNode }) { return <>{children}</>; }

function Stat({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`tabular-nums ${strong ? "text-lg font-bold text-slate-900" : "text-base font-semibold text-slate-700"}`}>{value}</div>
      {warn && <div className="text-xs text-red-600">{warn}</div>}
    </div>
  );
}

function DayInput({ value, max, disabled, onCommit }: { value: number | null; max: number; disabled: boolean; onCommit: (v: number) => void }) {
  const [txt, setTxt] = useState(value == null ? "" : String(value));
  useEffect(() => { setTxt(value == null ? "" : String(value)); }, [value]);
  function commit() {
    const n = txt.trim() === "" ? null : parseInt(txt, 10);
    if (n == null || isNaN(n)) { setTxt(value == null ? "" : String(value)); return; }
    if (n < 0 || n > max) { alert(`Liczba dni musi być od 0 do ${max}.`); setTxt(value == null ? "" : String(value)); return; }
    if (n !== value) onCommit(n);
  }
  return (
    <input className="w-14 text-center rounded border border-slate-300 px-1 py-1 text-sm disabled:bg-slate-50 disabled:text-slate-500"
      inputMode="numeric" value={txt} disabled={disabled} placeholder="—"
      onChange={(e) => setTxt(e.target.value.replace(/[^0-9]/g, ""))} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

// ── Pozycje (uznania / potrącenia) jednego kierowcy ───────────
function EntriesPanel({ person, period, entries, editable, issues, note, onNote, onChanged }: {
  person: Person; period: Period; entries: Entry[]; editable: boolean; issues: Issue[];
  note: string; onNote: (v: string) => Promise<void>; onChanged: () => Promise<void>;
}) {
  const [kind, setKind] = useState<EntryKind>("credit");
  const [category, setCategory] = useState(CREDIT_CATEGORIES[0]);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"PLN" | "EUR">("PLN");
  const [fx, setFx] = useState(String(DEFAULT_EUR_PLN));
  const [basis, setBasis] = useState("");
  const [noteTxt, setNoteTxt] = useState(note);
  const [busy, setBusy] = useState(false);
  useEffect(() => setNoteTxt(note), [note]);
  const cats = kind === "credit" ? CREDIT_CATEGORIES : DEDUCTION_CATEGORIES;
  useEffect(() => setCategory(cats[0]), [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    const a = num(amount); const rate = currency === "EUR" ? num(fx) : 1;
    if (a == null || a <= 0) { alert("Wpisz kwotę większą od zera (bez znaku — znak nadaje typ pozycji)."); return; }
    if (rate == null || rate <= 0) { alert("Podaj poprawny kurs."); return; }
    if (!description.trim()) { alert("Opis jest obowiązkowy."); return; }
    if (kind === "deduction" && !basis.trim()) { alert("Potrącenie wymaga podstawy (np. zgoda kierowcy, protokół, zapis umowy)."); return; }
    const pln = round2(a * rate);
    setBusy(true);
    const { error } = await supabase.from("payroll_entries").insert({
      period_id: period.id, person_id: person.id, kind, category, description: description.trim(),
      basis: kind === "deduction" ? basis.trim() : null, currency, amount_orig: a, fx_rate: rate,
      amount_pln: kind === "deduction" ? -pln : pln,
    });
    setBusy(false);
    if (error) { alert("Nie zapisano: " + error.message); return; }
    setDescription(""); setAmount(""); setBasis("");
    await onChanged();
  }
  async function remove(id: string) {
    if (!confirm("Usunąć pozycję?")) return;
    const { error } = await supabase.from("payroll_entries").delete().eq("id", id);
    if (error) alert(error.message);
    await onChanged();
  }

  return (
    <div className="space-y-3">
      {issues.length > 0 && (
        <ul className="text-xs space-y-0.5">
          {issues.map((i, k) => <li key={k} className={i.level === "error" ? "text-red-600" : "text-amber-700"}>{i.level === "error" ? "Błąd" : "Uwaga"}: {i.text}</li>)}
        </ul>
      )}
      {entries.length === 0 ? <div className="text-xs text-slate-400">Brak uznań i potrąceń.</div> : (
        <table className="w-full text-xs">
          <thead className="text-slate-500"><tr>
            <th className="text-left py-1">Typ</th><th className="text-left">Kategoria</th><th className="text-left">Opis</th><th className="text-left">Podstawa</th>
            <th className="text-right">Kwota</th><th className="text-right">PLN</th><th></th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-slate-200">
                <td className="py-1">{e.kind === "credit" ? "Uznanie" : "Potrącenie"}</td>
                <td>{e.category}</td><td className="max-w-md">{e.description}</td><td className="text-slate-500">{e.basis ?? "—"}</td>
                <td className="text-right tabular-nums">{e.currency === "EUR" ? `${fmtPln(e.amount_orig)} EUR × ${e.fx_rate.toFixed(2)}` : "—"}</td>
                <td className={`text-right tabular-nums font-medium ${e.amount_pln < 0 ? "text-red-600" : ""}`}>{fmtPln(e.amount_pln)}</td>
                <td className="text-right">{editable && <button className="text-red-500 hover:underline" onClick={() => remove(e.id)}>usuń</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
          <div><label className="label">Typ</label>
            <select className="input-field" value={kind} onChange={(e) => setKind(e.target.value as EntryKind)}>
              <option value="credit">Uznanie / zwrot</option><option value="deduction">Potrącenie / mandat</option></select></div>
          <div><label className="label">Kategoria</label>
            <select className="input-field" value={category} onChange={(e) => setCategory(e.target.value)}>{cats.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="md:col-span-2"><label className="label">Opis (np. 20.06 tankowanie HVO, Hiszpania)</label>
            <input className="input-field" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div><label className="label">Kwota</label>
            <div className="flex gap-1">
              <input className="input-field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <select className="input-field !w-20" value={currency} onChange={(e) => setCurrency(e.target.value as "PLN" | "EUR")}><option>PLN</option><option>EUR</option></select>
            </div></div>
          {currency === "EUR" ? (
            <div><label className="label">Kurs EUR→PLN</label><input className="input-field" inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} /></div>
          ) : <div />}
          {kind === "deduction" && (
            <div className="md:col-span-4"><label className="label">Podstawa potrącenia (zgoda, protokół, zapis umowy)</label>
              <input className="input-field" value={basis} onChange={(e) => setBasis(e.target.value)} /></div>
          )}
          <div className="md:col-start-6"><button className="btn-primary w-full" disabled={busy} onClick={add}>Dodaj</button></div>
        </div>
      )}
      <div>
        <label className="label">Uwaga do kierowcy (np. chorobowe, część miesiąca)</label>
        <input className="input-field" value={noteTxt} disabled={!editable} onChange={(e) => setNoteTxt(e.target.value)}
          onBlur={() => { if (noteTxt !== note) onNote(noteTxt); }} />
      </div>
    </div>
  );
}

function IssuesPanel({ issues, people }: { issues: Issue[]; people: Person[] }) {
  if (issues.length === 0) return <div className="card text-sm text-emerald-700">Walidacja: bez uwag.</div>;
  const errors = issues.filter((i) => i.level === "error"), warns = issues.filter((i) => i.level === "warn");
  void people;
  return (
    <div className="card space-y-2 text-sm">
      <h2 className="font-semibold text-slate-800">Walidacja: {errors.length} błędów, {warns.length} ostrzeżeń</h2>
      <ul className="space-y-1">
        {errors.map((i, k) => <li key={"e" + k} className="text-red-600">Błąd: {i.text}</li>)}
        {warns.map((i, k) => <li key={"w" + k} className="text-amber-700">Uwaga: {i.text}</li>)}
      </ul>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Zakładka: Osoby i stawki (approver)
// ══════════════════════════════════════════════════════════════
function PeopleTab({ people, rates, period, onChanged }: { people: Person[]; rates: Rate[]; period: Period | null; onChanged: () => Promise<void> }) {
  const now = new Date();
  const [first, setFirst] = useState(""); const [last, setLast] = useState("");
  const [rateFrom, setRateFrom] = useState(`${period?.year ?? now.getFullYear()}-${String(period?.month ?? now.getMonth() + 1).padStart(2, "0")}`);
  const [editing, setEditing] = useState<string | null>(null);
  const [dayRate, setDayRate] = useState(""); const [leaveRate, setLeaveRate] = useState("150");

  async function addPerson() {
    if (!first.trim() || !last.trim()) { alert("Podaj imię i nazwisko."); return; }
    const { error } = await supabase.from("payroll_people").insert({ first_name: first.trim(), last_name: last.trim() });
    if (error) { alert(error.message); return; }
    setFirst(""); setLast(""); await onChanged();
  }
  async function patchPerson(id: string, patch: Partial<Person>) {
    const { error } = await supabase.from("payroll_people").update(patch).eq("id", id);
    if (error) alert(error.message);
    await onChanged();
  }
  async function saveRate(personId: string) {
    const d = num(dayRate), l = num(leaveRate);
    if (d == null || d < 0 || l == null || l < 0) { alert("Podaj poprawne stawki."); return; }
    const { error } = await supabase.from("payroll_rates").upsert(
      { person_id: personId, day_rate: d, leave_rate: l, valid_from: `${rateFrom}-01` }, { onConflict: "person_id,valid_from" });
    if (error) { alert(error.message); return; }
    setEditing(null); setDayRate(""); await onChanged();
  }

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-3">
        <div><label className="label">Imię</label><input className="input-field" value={first} onChange={(e) => setFirst(e.target.value)} /></div>
        <div><label className="label">Nazwisko</label><input className="input-field" value={last} onChange={(e) => setLast(e.target.value)} /></div>
        <button className="btn-secondary" onClick={addPerson}>Dodaj kierowcę</button>
        <div className="flex-1" />
        <div><label className="label">Nowa stawka obowiązuje od (miesiąc)</label>
          <input className="input-field" type="month" value={rateFrom} onChange={(e) => setRateFrom(e.target.value)} /></div>
      </div>
      <div className="card !p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr>
            <th className="text-left px-3 py-2">Imię</th><th className="text-left px-3 py-2">Nazwisko</th>
            <th className="px-3 py-2">Aktywny</th><th className="text-left px-3 py-2">Stawki (od miesiąca)</th><th></th></tr></thead>
          <tbody>
            {people.map((p) => {
              const hist = rates.filter((r) => r.person_id === p.id).sort((a, b) => b.valid_from.localeCompare(a.valid_from));
              return (
                <tr key={p.id} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-1.5"><NameInput value={p.first_name} onCommit={(v) => patchPerson(p.id, { first_name: v })} /></td>
                  <td className="px-3 py-1.5"><NameInput value={p.last_name} onCommit={(v) => patchPerson(p.id, { last_name: v })} /></td>
                  <td className="px-3 py-1.5 text-center"><input type="checkbox" checked={p.active} onChange={(e) => patchPerson(p.id, { active: e.target.checked })} /></td>
                  <td className="px-3 py-1.5 text-xs text-slate-600">
                    {hist.length === 0 ? <span className="text-red-500">brak stawki</span> : hist.map((r) => (
                      <div key={r.id}>{r.valid_from.slice(0, 7)}: {r.day_rate} zł/dzień, {r.leave_rate} zł/urlop</div>
                    ))}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {editing === p.id ? (
                      <div className="flex gap-1 items-center justify-end">
                        <input className="input-field !w-20" placeholder="za dzień" inputMode="decimal" value={dayRate} onChange={(e) => setDayRate(e.target.value)} />
                        <input className="input-field !w-20" placeholder="urlop" inputMode="decimal" value={leaveRate} onChange={(e) => setLeaveRate(e.target.value)} />
                        <button className="btn-primary !px-3 !py-1.5" onClick={() => saveRate(p.id)}>Zapisz</button>
                        <button className="text-slate-400 text-xs" onClick={() => setEditing(null)}>anuluj</button>
                      </div>
                    ) : <button className="text-blue-600 hover:underline text-xs" onClick={() => setEditing(p.id)}>Ustaw stawkę</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input className="w-full rounded border border-transparent hover:border-slate-300 px-1 py-1 text-sm" value={v}
    onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() && v !== value) onCommit(v.trim()); else setV(value); }} />;
}

// ══════════════════════════════════════════════════════════════
// Zakładka: Import z pliku (approver) — jednorazowo, do pustego miesiąca
// ══════════════════════════════════════════════════════════════
function ImportTab({ period, people, rates, lines, entries, onDone }: {
  period: Period | null; people: Person[]; rates: Rate[]; lines: Line[]; entries: Entry[]; onDone: () => Promise<void>;
}) {
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!period) return <div className="card text-sm text-slate-500">Najpierw otwórz miesiąc, do którego chcesz zaimportować plik.</div>;
  const target = period;
  const canImport = target.status === "otwarty" && lines.length === 0 && entries.length === 0;

  async function onFile(f: File | undefined) {
    if (!f) return;
    setResult(null); setFileName(f.name);
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    setRows(parseSettlementWorkbook(wb, target.year, target.month));
  }

  async function run() {
    if (!rows) return;
    if (!confirm(`Zaimportować ${rows.length} arkuszy do miesiąca ${periodLabel(target.year, target.month)}?`)) return;
    setBusy(true); setResult(null);
    try {
      const dim = daysInMonth(target.year, target.month);
      const bySheet = new Map(people.filter((p) => p.sheet_name).map((p) => [p.sheet_name as string, p]));
      const toCreate = rows.filter((r) => !bySheet.has(r.sheet));
      if (toCreate.length) {
        const { data, error } = await supabase.from("payroll_people").insert(
          toCreate.map((r) => ({ first_name: r.first || r.sheet, last_name: r.last || "", sheet_name: r.sheet, active: r.days + r.leave > 0 || r.credits !== 0 || r.deductions !== 0 })),
        ).select();
        if (error) throw new Error("osoby: " + error.message);
        (data as Person[]).forEach((p) => bySheet.set(p.sheet_name as string, p));
      }
      const first = firstOf(target.year, target.month);
      const newRates = rows.filter((r) => r.dayRate != null && r.leaveRate != null).flatMap((r) => {
        const p = bySheet.get(r.sheet)!;
        const cur = rateFor(rates, p.id, target.year, target.month);
        if (cur && cur.day_rate === r.dayRate && cur.leave_rate === r.leaveRate) return [];
        return [{ person_id: p.id, day_rate: r.dayRate, leave_rate: r.leaveRate, valid_from: first }];
      });
      if (newRates.length) {
        const { error } = await supabase.from("payroll_rates").upsert(newRates, { onConflict: "person_id,valid_from" });
        if (error) throw new Error("stawki: " + error.message);
      }
      const importable = rows.filter((r) => r.days + r.leave <= dim && (r.days + r.leave > 0 || r.credits !== 0 || r.deductions !== 0));
      if (importable.length) {
        const { error } = await supabase.from("payroll_lines").insert(importable.map((r) => ({
          period_id: target.id, person_id: bySheet.get(r.sheet)!.id, days_worked: r.days, days_leave: r.leave, days_sick: 0,
          note: /chorob/i.test(r.creditsText) ? r.creditsText : null,
        })));
        if (error) throw new Error("dni: " + error.message);
      }
      const newEntries = importable.flatMap((r) => {
        const pid = bySheet.get(r.sheet)!.id;
        const out: Record<string, unknown>[] = [];
        if (r.credits > 0) out.push({ period_id: target.id, person_id: pid, kind: "credit", category: "Import z pliku", description: r.creditsText || "Import z pliku (brak opisu)", basis: null, currency: "PLN", amount_orig: r.credits, fx_rate: 1, amount_pln: r.credits });
        if (r.deductions < 0) out.push({ period_id: target.id, person_id: pid, kind: "deduction", category: "Import z pliku", description: r.deductionsText || "Import z pliku (brak opisu)", basis: "do uzupełnienia (import z pliku)", currency: "PLN", amount_orig: -r.deductions, fx_rate: 1, amount_pln: r.deductions });
        return out;
      });
      if (newEntries.length) {
        const { error } = await supabase.from("payroll_entries").insert(newEntries);
        if (error) throw new Error("pozycje: " + error.message);
      }
      const skipped = rows.filter((r) => r.blocking);
      setResult(`Zaimportowano ${importable.length} kierowców i ${newEntries.length} pozycji. Pominięto lub wymaga poprawy ręcznej: ${skipped.length} (${skipped.map((s) => s.sheet).join(", ") || "brak"}).`);
      setRows(null);
      await onDone();
    } catch (e) { setResult("Błąd importu: " + (e as Error).message); }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3 text-sm">
        <p className="text-slate-600">
          Import pliku w układzie „wypłaty kierowcy &lt;miesiąc&gt;” (arkusz na kierowcę) do miesiąca <b>{periodLabel(target.year, target.month)}</b>.
          Uznania i potrącenia z pliku trafiają jako jedna pozycja z opisem z pliku (podstawa potrącenia: „do uzupełnienia”).
          Pozycje o błędnym znaku i arkusze z dniami ponad miesiąc nie są importowane — pokazuję je poniżej do ręcznej poprawy.
        </p>
        {!canImport && <div className="text-amber-700">Import jest możliwy tylko do pustego, otwartego miesiąca.</div>}
        <input type="file" accept=".ods,.xlsx,.xls" disabled={!canImport} onChange={(e) => onFile(e.target.files?.[0])} />
        {fileName && <div className="text-xs text-slate-500">{fileName}</div>}
        {result && <div className="text-emerald-700">{result}</div>}
      </div>
      {rows && (
        <div className="card !p-0 overflow-x-auto">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 text-sm">
            <span>{rows.length} arkuszy · {rows.filter((r) => r.issues.length).length} z uwagami</span>
            <button className="btn-primary" disabled={busy || !canImport} onClick={run}>{busy ? "Importuję…" : "Importuj"}</button>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>
              <th className="text-left px-3 py-2">Arkusz</th><th>Dni</th><th>Urlop</th><th className="text-right px-2">Uznania</th><th className="text-right px-2">Obciążenia</th><th className="text-right px-2">Suma w pliku</th><th className="text-left px-3">Uwagi</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sheet} className={`border-t border-slate-100 ${r.blocking ? "bg-red-50" : r.issues.length ? "bg-amber-50/60" : ""}`}>
                  <td className="px-3 py-1">{r.sheet}</td><td className="text-center">{r.days}</td><td className="text-center">{r.leave}</td>
                  <td className="text-right px-2 tabular-nums">{r.credits ? fmtPln(r.credits) : ""}</td>
                  <td className="text-right px-2 tabular-nums">{r.deductions ? fmtPln(r.deductions) : ""}</td>
                  <td className="text-right px-2 tabular-nums">{r.total != null ? fmtPln(r.total) : ""}</td>
                  <td className="px-3 text-red-700">{r.issues.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Zakładka: Dziennik zmian (approver)
// ══════════════════════════════════════════════════════════════
function AuditTab({ nameOf, people }: { nameOf: (id: string | null) => string; people: Person[] }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    supabase.from("payroll_audit").select("*").order("at", { ascending: false }).limit(200)
      .then(({ data, error }) => { if (error) setErr(error.message); else setRows((data ?? []) as AuditRow[]); });
  }, []);
  const personName = (r: AuditRow) => {
    const o = (r.new_row ?? r.old_row ?? {}) as Record<string, unknown>;
    const pid = (o.person_id as string | undefined) ?? (r.table_name === "payroll_people" ? (o.id as string) : undefined);
    const p = pid ? people.find((x) => x.id === pid) : undefined;
    return p ? fullName(p) : "";
  };
  const summary = (r: AuditRow) => {
    const o = (r.new_row ?? r.old_row ?? {}) as Record<string, unknown>;
    if (r.table_name === "payroll_lines") return `dni: ${o.days_worked}/${o.days_leave}/${o.days_sick}`;
    if (r.table_name === "payroll_entries") return `${o.kind === "credit" ? "uznanie" : "potrącenie"} ${o.amount_pln} PLN — ${String(o.description ?? "").slice(0, 60)}`;
    if (r.table_name === "payroll_periods") return `status: ${o.status}, wersja ${o.version}`;
    if (r.table_name === "payroll_rates" || r.table_name === "payroll_period_rates") return `stawki: ${o.day_rate}/${o.leave_rate}`;
    return "";
  };
  return (
    <div className="card !p-0 overflow-x-auto">
      {err && <div className="p-4 text-sm text-red-600">{err}</div>}
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr>
          <th className="text-left px-3 py-2">Kiedy</th><th className="text-left">Kto</th><th className="text-left">Tabela</th><th className="text-left">Akcja</th><th className="text-left">Kierowca</th><th className="text-left">Zmiana</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="px-3 py-1 whitespace-nowrap">{fmtDateTime(r.at)}</td><td>{nameOf(r.user_id)}</td>
              <td>{r.table_name.replace("payroll_", "")}</td><td>{r.action}</td><td>{personName(r)}</td><td>{summary(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
