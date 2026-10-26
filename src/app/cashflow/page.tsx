"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { AuthSession as Session } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { useSettings } from "@/lib/settings-context";
import {
  type PayInvoice, type RecvInvoice, type CashflowOptions, type ReceivableRow, type WeekRow,
  buildCashflow, parseReceivablesWorkbook, addDays, daysBetween, round2,
} from "@/lib/cashflow";

// ══════════════════════════════════════════════════════════════
// /cashflow — ile faktur, kiedy i na jaką kwotę trzeba zapłacić oraz ile
// wpłynie wg terminów płatności. Zobowiązania: faktury kosztowe B&M
// (cost_invoices, import na /platnosci; bez KRAVTT). Należności: faktury
// sprzedażowe (receivable_invoices, import poniżej; migracja 032).
// Faktury sfinansowane przez IFIS nie są przyszłym wpływem (IFIS wpłaca całość
// przy finansowaniu) — liczona jest tylko opłata 0,5% za 30 dni.
// ══════════════════════════════════════════════════════════════

const fmt0 = (n: number) => Math.round(n).toLocaleString("pl-PL");
const fmtDate = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const fmtDateFull = (s: string | null) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : "—");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const num = (s: string) => { const n = parseFloat(s.replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? null : n; };

interface CostRow { numer: string | null; sprzedawca: string | null; typ_kosztu: string | null; termin_platnosci: string | null; pozostalo_do_zaplaty_pln: number | null; odbiorca?: string | null }
interface Snap { id: string; account: string; currency: "PLN" | "EUR"; amount: number; as_of: string; created_at: string }
interface RecvRow { numer: string; kontrahent: string | null; termin_platnosci: string | null; data_wystawienia: string | null; pozostalo_pln: number | null; faktor: string | null }

export default function CashflowPage() {
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
        <h1 className="text-lg font-bold text-slate-900 mb-1">Cashflow</h1>
        <p className="text-sm text-slate-500 mb-4">Dane finansowe — dostęp tylko dla zalogowanych (ten sam login co CRM).</p>
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

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) return { rows: out, error };
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return { rows: out, error: null as null };
}

function Dashboard({ session }: { session: Session }) {
  const today = useMemo(todayStr, []);
  const [cost, setCost] = useState<CostRow[]>([]);
  const [recv, setRecv] = useState<RecvRow[]>([]);
  const [meta, setMeta] = useState<{ costImport: string | null; costLatest: string | null; hasOdbiorca: boolean; recvImport: string | null; recvLatest: string | null }>(
    { costImport: null, costLatest: null, hasOdbiorca: true, recvImport: null, recvLatest: null });
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<number | "over" | "later" | null>(null);

  const [weeks, setWeeks] = useState(13);
  const [overduePay, setOverduePay] = useState(0);
  const [overdueRecv, setOverdueRecv] = useState(0);
  const [opening, setOpening] = useState("");
  const { settings } = useSettings();
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [eurStr, setEurStr] = useState("");
  const [perStarted, setPerStarted] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const errs: string[] = [];
    let c = await fetchAll<CostRow>((a, b) => supabase.from("cost_invoices")
      .select("numer,sprzedawca,typ_kosztu,termin_platnosci,pozostalo_do_zaplaty_pln,odbiorca").gt("pozostalo_do_zaplaty_pln", 0.01).range(a, b));
    let hasOdb = true;
    if (c.error && /odbiorca/i.test(c.error.message)) {
      hasOdb = false;
      c = await fetchAll<CostRow>((a, b) => supabase.from("cost_invoices")
        .select("numer,sprzedawca,typ_kosztu,termin_platnosci,pozostalo_do_zaplaty_pln").gt("pozostalo_do_zaplaty_pln", 0.01).range(a, b));
    }
    if (c.error) errs.push("Faktury kosztowe: " + c.error.message);
    const r = await fetchAll<RecvRow>((a, b) => supabase.from("receivable_invoices")
      .select("numer,kontrahent,termin_platnosci,data_wystawienia,pozostalo_pln,faktor").gt("pozostalo_pln", 0.01).range(a, b));
    if (r.error) errs.push(/does not exist|schema cache/.test(r.error.message)
      ? "Brak tabeli należności — uruchom migrację 032_cashflow.sql w Supabase Studio." : "Należności: " + r.error.message);
    const one = async (table: string, col: string) => {
      const { data } = await supabase.from(table).select(col).not(col, "is", null).order(col, { ascending: false }).limit(1);
      return ((data ?? []) as unknown as Record<string, string>[])[0]?.[col] ?? null;
    };
    const [ci, cl, ri, rl] = await Promise.all([
      one("cost_invoices", "imported_at"), one("cost_invoices", "data_wystawienia"),
      one("receivable_invoices", "imported_at"), one("receivable_invoices", "data_wystawienia"),
    ]);
    const bal = await supabase.from("cash_balances").select("id,account,currency,amount,as_of,created_at")
      .order("as_of", { ascending: false }).order("created_at", { ascending: false }).limit(500);
    if (bal.error) errs.push(/does not exist|schema cache/.test(bal.error.message)
      ? "Brak tabeli sald kont — uruchom migrację 033_cash_balances.sql w Supabase Studio." : "Salda kont: " + bal.error.message);
    setSnaps(((bal.data ?? []) as Snap[]).map((x) => ({ ...x, amount: Number(x.amount) })));
    setCost(c.rows); setRecv(r.rows); setErrors(errs);
    setMeta({ costImport: ci, costLatest: cl, hasOdbiorca: hasOdb && c.rows.some((x) => x.odbiorca), recvImport: ri, recvLatest: rl });
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const { pay, excludedKravtt, recvInv, noDueRecv } = useMemo(() => {
    let excl = 0;
    const p: PayInvoice[] = [];
    for (const x of cost) {
      if (!x.numer || !x.termin_platnosci || (x.pozostalo_do_zaplaty_pln ?? 0) <= 0.01) continue;
      if (/KRAVTT/i.test(x.odbiorca ?? "")) { excl++; continue; }
      p.push({ numer: x.numer, kontrahent: x.sprzedawca ?? "", termin: x.termin_platnosci, kwota: x.pozostalo_do_zaplaty_pln as number, kategoria: x.typ_kosztu });
    }
    const rv: RecvInvoice[] = [];
    let noDue = 0;
    for (const x of recv) {
      if ((x.pozostalo_pln ?? 0) <= 0.01) continue;
      if (!x.termin_platnosci) { noDue++; continue; }
      rv.push({ numer: x.numer, kontrahent: x.kontrahent ?? "", termin: x.termin_platnosci, wystawiona: x.data_wystawienia, kwota: x.pozostalo_pln as number, faktor: x.faktor });
    }
    return { pay: p, excludedKravtt: excl, recvInv: rv, noDueRecv: noDue };
  }, [cost, recv]);

  // najnowszy zapis salda dla każdego konta; EUR przeliczane po kursie (domyślnie z ustawień aplikacji)
  const eurRate = num(eurStr) ?? settings.plnEurRate;
  const latest = useMemo(() => {
    const m = new Map<string, Snap>();
    for (const s of snaps) if (!m.has(s.account)) m.set(s.account, s); // snaps są posortowane od najnowszych
    return [...m.values()].sort((a, b) => a.account.localeCompare(b.account, "pl"));
  }, [snaps]);
  const totalPln = useMemo(() => round2(latest.reduce((s, x) => s + (x.currency === "EUR" ? x.amount * eurRate : x.amount), 0)), [latest, eurRate]);

  const opts: CashflowOptions = useMemo(() => ({
    today, weeks, overduePayWeeks: overduePay, overdueRecvWeeks: overdueRecv, opening: totalPln + (num(opening) ?? 0), ifisPerStarted: perStarted,
  }), [today, weeks, overduePay, overdueRecv, opening, perStarted, totalPln]);
  const cf = useMemo(() => buildCashflow(pay, recvInv, opts), [pay, recvInv, opts]);

  const ageDays = (iso: string | null) => (iso ? daysBetween(iso.slice(0, 10), today) : null);
  const costAge = ageDays(meta.costImport), recvAge = ageDays(meta.recvImport);
  const next2 = cf.weeks.slice(0, 2).reduce((a, w) => ({ pay: a.pay + w.paySum, recv: a.recv + w.recvSum, payN: a.payN + w.payN, recvN: a.recvN + w.recvN }), { pay: 0, recv: 0, payN: 0, recvN: 0 });

  function exportXlsx() {
    const wb = XLSX.utils.book_new();
    const rows: (string | number)[][] = [["Tydzień od", "do", "Faktur do zapłaty", "Do zapłaty zł", "w tym zaległości rozłożone zł", "Faktur do otrzymania", "Do otrzymania zł", "w tym zaległości rozłożone zł", "Opłata IFIS zł", "Saldo tygodnia zł", "Saldo narastające zł"]];
    rows.push(["Po terminie", "", cf.overdue.payN, cf.overdue.paySum, "", cf.overdue.recvN, cf.overdue.recvSum, "", "", "", ""]);
    cf.weeks.forEach((w) => rows.push([w.start, w.end, w.payN, w.paySum + w.spreadPay, w.spreadPay, w.recvN, w.recvSum + w.spreadRecv, w.spreadRecv, w.ifisFee, w.net, w.cum]));
    if (cf.later.payN + cf.later.recvN > 0) rows.push(["Później", "", cf.later.payN, cf.later.paySum, "", cf.later.recvN, cf.later.recvSum, "", "", "", ""]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Tygodnie");
    const wk = (d: string) => (d < today ? "po terminie" : `od ${fmtDateFull(weekStartOf(d, today))}`);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Numer", "Sprzedawca", "Kategoria", "Termin", "Kwota do zapłaty zł", "Tydzień"],
      ...[...pay].sort((a, b) => a.termin.localeCompare(b.termin)).map((p) => [p.numer, p.kontrahent, p.kategoria ?? "", p.termin, p.kwota, wk(p.termin)])]), "Do zapłaty");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Numer", "Klient", "Data wystawienia", "Termin", "Kwota do otrzymania zł", "Faktor", "Tydzień"],
      ...[...recvInv].sort((a, b) => a.termin.localeCompare(b.termin)).map((c) => [c.numer, c.kontrahent, c.wystawiona ?? "", c.termin, c.kwota, c.faktor ?? "", wk(c.termin)])]), "Do otrzymania");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Konto", "Waluta", "Saldo", "Na dzień", "Wartość zł"],
      ...latest.map((x) => [x.account, x.currency, x.amount, x.as_of, round2(x.currency === "EUR" ? x.amount * eurRate : x.amount)]),
      ["Razem zł", "", "", "", totalPln], ["Kurs EUR/PLN", "", "", "", eurRate]]), "Salda kont");
    XLSX.writeFile(wb, `Cashflow_${today}.xlsx`);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cashflow</h1>
          <p className="text-slate-500 text-sm mt-1">Ile faktur, kiedy i na jaką kwotę zapłacić oraz ile wpłynie wg terminów płatności · stan na {fmtDateFull(today)}</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <button className="btn-secondary" onClick={exportXlsx} disabled={loading}>Pobierz .xlsx</button>
          <span className="text-slate-500">{session.user.email}</span>
          <button className="text-slate-400 hover:text-slate-700" onClick={() => supabase.auth.signOut()}>Wyloguj</button>
        </div>
      </div>

      {errors.map((e, i) => <div key={i} className="card text-sm text-red-600">{e}</div>)}

      <DataBanner costAge={costAge} recvAge={recvAge} meta={meta} excludedKravtt={excludedKravtt} noDueRecv={noDueRecv}
        nRecv={recvInv.length} nPay={pay.length} />

      {loading ? <div className="p-6 text-sm text-slate-400">Ładowanie…</div> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card title="Po terminie: do zapłaty" value={fmt0(cf.overdue.paySum) + " zł"} sub={`${cf.overdue.payN} faktur`} tone="red" />
            <Card title="Po terminie: do otrzymania" value={fmt0(cf.overdue.recvSum) + " zł"} sub={`${cf.overdue.recvN} faktur (bez IFIS)`} tone="amber" />
            <Card title="Najbliższe 2 tygodnie: do zapłaty" value={fmt0(next2.pay) + " zł"} sub={`${next2.payN} faktur`} />
            <Card title="Najbliższe 2 tygodnie: do otrzymania" value={fmt0(next2.recv) + " zł"} sub={`${next2.recvN} faktur`} />
          </div>

          {cf.ifis.n > 0 && (
            <div className="card text-sm text-slate-600">
              <b>IFIS:</b> {cf.ifis.n} faktur ({fmt0(cf.ifis.base)} zł, w tym {cf.ifis.overdueN} po terminie klienta) jest już sfinansowanych, więc gotówka wpłynęła i nie ma ich
              w „do otrzymania”. Szacowana opłata do chwili wpłaty klientów: <b>{fmt0(cf.ifis.fee)} zł</b> (0,5% za {perStarted ? "każde rozpoczęte" : ""} 30 dni od daty wystawienia).
            </div>
          )}

          <BalancesCard latest={latest} eurRate={eurRate} eurStr={eurStr} setEurStr={setEurStr} defaultEur={settings.plnEurRate}
            totalPln={totalPln} today={today} onChanged={load} />

          <div className="card flex flex-wrap items-end gap-4">
            <div><label className="label">Tygodni w tabeli</label>
              <select className="input-field !w-24" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[4, 8, 13, 26].map((n) => <option key={n}>{n}</option>)}</select></div>
            <div><label className="label">Zaległe zobowiązania zapłacę w (tyg.)</label>
              <input className="input-field !w-28" type="number" min={0} max={weeks} value={overduePay} onChange={(e) => setOverduePay(Math.max(0, Math.min(weeks, Number(e.target.value) || 0)))} /></div>
            <div><label className="label">Zaległe należności wpłyną w (tyg.)</label>
              <input className="input-field !w-28" type="number" min={0} max={weeks} value={overdueRecv} onChange={(e) => setOverdueRecv(Math.max(0, Math.min(weeks, Number(e.target.value) || 0)))} /></div>
            <div><label className="label">Korekta gotówki (zł)</label>
              <input className="input-field !w-36" inputMode="decimal" value={opening} placeholder="0" onChange={(e) => setOpening(e.target.value)} /></div>
            <label className="flex items-center gap-2 text-sm text-slate-600 pb-2"><input type="checkbox" checked={perStarted} onChange={(e) => setPerStarted(e.target.checked)} /> opłata IFIS za każde rozpoczęte 30 dni</label>
            <div className="text-xs text-slate-400 w-full">0 tygodni = zaległości zostają w osobnym wierszu „po terminie” i nie wchodzą do salda tygodniowego. Wpisz liczbę tygodni, żeby założyć ich zapłatę lub wpływ równymi częściami.</div>
          </div>

          <div className="card !p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Tydzień</th>
                  <th className="text-right px-3 py-2">Faktur do zapłaty</th><th className="text-right px-3 py-2">Do zapłaty zł</th>
                  <th className="text-right px-3 py-2">Faktur do otrzymania</th><th className="text-right px-3 py-2">Do otrzymania zł</th>
                  <th className="text-right px-3 py-2">Opłata IFIS</th>
                  <th className="text-right px-3 py-2">Saldo tygodnia</th><th className="text-right px-3 py-2">Saldo narastające</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-100 bg-red-50/50 cursor-pointer" onClick={() => setExpanded(expanded === "over" ? null : "over")}>
                  <td className="px-3 py-2 font-medium">Po terminie</td>
                  <td className="px-3 py-2 text-right tabular-nums">{cf.overdue.payN}</td><td className="px-3 py-2 text-right tabular-nums text-red-600">{fmt0(cf.overdue.paySum)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{cf.overdue.recvN}</td><td className="px-3 py-2 text-right tabular-nums">{fmt0(cf.overdue.recvSum)}</td>
                  <td className="px-3 py-2" /><td className="px-3 py-2 text-right tabular-nums text-slate-400" colSpan={2}>netto zaległości: {fmt0(cf.overdue.recvSum - cf.overdue.paySum)} zł</td>
                </tr>
                {expanded === "over" && <DetailRow pay={cf.overdue.payItems} recv={cf.overdue.recvItems} ifis={[]} />}
                {cf.weeks.map((w) => (
                  <WeekLines key={w.idx} w={w} open={expanded === w.idx} onToggle={() => setExpanded(expanded === w.idx ? null : w.idx)} />
                ))}
                {cf.later.payN + cf.later.recvN > 0 && (
                  <>
                    <tr className="border-t border-slate-100 cursor-pointer" onClick={() => setExpanded(expanded === "later" ? null : "later")}>
                      <td className="px-3 py-2 font-medium">Później</td>
                      <td className="px-3 py-2 text-right tabular-nums">{cf.later.payN}</td><td className="px-3 py-2 text-right tabular-nums">{fmt0(cf.later.paySum)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{cf.later.recvN}</td><td className="px-3 py-2 text-right tabular-nums">{fmt0(cf.later.recvSum)}</td>
                      <td colSpan={3} />
                    </tr>
                    {expanded === "later" && <DetailRow pay={cf.later.payItems} recv={cf.later.recvItems} ifis={[]} />}
                  </>
                )}
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                  <td className="px-3 py-2">Razem otwarte</td>
                  <td className="px-3 py-2 text-right tabular-nums">{cf.totals.payN}</td><td className="px-3 py-2 text-right tabular-nums">{fmt0(cf.totals.paySum)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{cf.totals.recvN}</td><td className="px-3 py-2 text-right tabular-nums">{fmt0(cf.totals.recvSum)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt0(cf.totals.ifisFee)}</td><td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">
            Uwzględnia tylko faktury już wystawione. Nie ma tu przyszłej sprzedaży, wypłat kierowców, rat, podatków ani innych płatności bez faktury.
            Terminy to terminy z faktur, nie przewidywane daty faktycznej płatności.
          </p>

          <ReceivablesImport onDone={load} />
        </>
      )}
    </div>
  );
}

function weekStartOf(d: string, today: string): string {
  const k = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7;
  const w0 = addDays(today, -k);
  const idx = Math.floor(daysBetween(w0, d) / 7);
  return addDays(w0, idx * 7);
}

function Card({ title, value, sub, tone }: { title: string; value: string; sub: string; tone?: "red" | "amber" }) {
  return (
    <div className="card !p-4">
      <div className="text-xs text-slate-500">{title}</div>
      <div className={`text-xl font-bold tabular-nums ${tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-slate-900"}`}>{value}</div>
      <div className="text-xs text-slate-400">{sub}</div>
    </div>
  );
}

function DataBanner({ costAge, recvAge, meta, excludedKravtt, noDueRecv, nRecv, nPay }: {
  costAge: number | null; recvAge: number | null;
  meta: { costImport: string | null; costLatest: string | null; hasOdbiorca: boolean; recvImport: string | null; recvLatest: string | null };
  excludedKravtt: number; noDueRecv: number; nRecv: number; nPay: number;
}) {
  const w: string[] = [];
  if (costAge == null) w.push("Brak faktur kosztowych w bazie — zaimportuj rejestr kosztów na stronie Płatności.");
  else if (costAge > 3) w.push(`Faktury kosztowe są sprzed ${costAge} dni (import ${fmtDateFull(meta.costImport)}). Zaimportuj świeży rejestr kosztów na stronie Płatności (zakładka Import), inaczej płatności z ostatnich dni nie są odjęte.`);
  if (!meta.hasOdbiorca && nPay > 0) w.push("Faktury kosztowe nie mają informacji o odbiorcy, więc faktury KRAVTT (odrębnej spółki) nie są odfiltrowane i zawyżają zobowiązania. Uruchom migrację 032 i zaimportuj rejestr kosztów ponownie.");
  if (recvAge == null) w.push("Brak należności w bazie — wczytaj rejestr faktur sprzedażowych w sekcji „Import należności” na dole strony.");
  else if (recvAge > 3) w.push(`Należności są sprzed ${recvAge} dni (import ${fmtDateFull(meta.recvImport)}). Wczytaj świeży rejestr faktur sprzedażowych — wpłaty z ostatnich dni nie są odjęte, więc zaległości mogą być zawyżone.`);
  if (noDueRecv > 0) w.push(`${noDueRecv} otwartych faktur sprzedażowych nie ma terminu płatności i nie wchodzi do tabeli.`);
  return (
    <div className="card text-sm space-y-1">
      <div className="text-slate-600">
        Zobowiązania: {nPay} otwartych faktur B&M{excludedKravtt > 0 ? ` (pominięto ${excludedKravtt} faktur KRAVTT)` : ""}, import {fmtDateFull(meta.costImport)}, najnowsza faktura {fmtDateFull(meta.costLatest)}.
        {" "}Należności: {nRecv} otwartych faktur, import {fmtDateFull(meta.recvImport)}, najnowsza faktura {fmtDateFull(meta.recvLatest)}.
      </div>
      {w.map((t, i) => <div key={i} className="text-amber-700">Uwaga: {t}</div>)}
    </div>
  );
}

function WeekLines({ w, open, onToggle }: { w: WeekRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="border-t border-slate-100 cursor-pointer hover:bg-slate-50" onClick={onToggle}>
        <td className="px-3 py-2 whitespace-nowrap">{fmtDate(w.start)}–{fmtDate(w.end)}{w.idx === 0 && <span className="ml-2 text-[10px] text-slate-400">bieżący</span>}</td>
        <td className="px-3 py-2 text-right tabular-nums">{w.payN || "—"}</td>
        <td className="px-3 py-2 text-right tabular-nums">{w.paySum + w.spreadPay ? fmt0(w.paySum + w.spreadPay) : "—"}{w.spreadPay > 0 && <span className="block text-[10px] text-slate-400">w tym zaległości {fmt0(w.spreadPay)}</span>}</td>
        <td className="px-3 py-2 text-right tabular-nums">{w.recvN || "—"}</td>
        <td className="px-3 py-2 text-right tabular-nums">{w.recvSum + w.spreadRecv ? fmt0(w.recvSum + w.spreadRecv) : "—"}{w.spreadRecv > 0 && <span className="block text-[10px] text-slate-400">w tym zaległości {fmt0(w.spreadRecv)}</span>}</td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-500">{w.ifisFee ? fmt0(w.ifisFee) : "—"}</td>
        <td className={`px-3 py-2 text-right tabular-nums font-medium ${w.net < 0 ? "text-red-600" : "text-emerald-700"}`}>{fmt0(w.net)}</td>
        <td className={`px-3 py-2 text-right tabular-nums font-semibold ${w.cum < 0 ? "text-red-600" : ""}`}>{fmt0(w.cum)}</td>
      </tr>
      {open && <DetailRow pay={w.payItems} recv={w.recvItems} ifis={w.ifisItems} />}
    </>
  );
}

function DetailRow({ pay, recv, ifis }: { pay: PayInvoice[]; recv: RecvInvoice[]; ifis: { inv: RecvInvoice; fee: number }[] }) {
  const P = [...pay].sort((a, b) => b.kwota - a.kwota), R = [...recv].sort((a, b) => b.kwota - a.kwota);
  return (
    <tr className="bg-slate-50/70">
      <td colSpan={8} className="px-4 py-3">
        <div className="grid md:grid-cols-2 gap-4 text-xs">
          <div>
            <div className="font-semibold text-slate-600 mb-1">Do zapłaty ({P.length})</div>
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full"><tbody>
                {P.map((p) => <tr key={p.numer + p.termin} className="border-t border-slate-200"><td className="py-1 pr-2 whitespace-nowrap">{fmtDateFull(p.termin)}</td><td className="pr-2">{p.kontrahent}</td><td className="pr-2 text-slate-400">{p.numer}</td><td className="text-right tabular-nums">{fmt0(p.kwota)}</td></tr>)}
                {P.length === 0 && <tr><td className="text-slate-400">brak</td></tr>}
              </tbody></table>
            </div>
          </div>
          <div>
            <div className="font-semibold text-slate-600 mb-1">Do otrzymania ({R.length})</div>
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full"><tbody>
                {R.map((c) => <tr key={c.numer} className="border-t border-slate-200"><td className="py-1 pr-2 whitespace-nowrap">{fmtDateFull(c.termin)}</td><td className="pr-2">{c.kontrahent}</td><td className="pr-2 text-slate-400">{c.numer}</td><td className="text-right tabular-nums">{fmt0(c.kwota)}</td></tr>)}
                {R.length === 0 && <tr><td className="text-slate-400">brak</td></tr>}
              </tbody></table>
            </div>
            {ifis.length > 0 && <div className="mt-2 text-slate-500">IFIS w tym tygodniu: {ifis.length} faktur, opłata {fmt0(ifis.reduce((s, x) => s + x.fee, 0))} zł (gotówka już wpłynęła od IFIS).</div>}
          </div>
        </div>
      </td>
    </tr>
  );
}

function BalancesCard({ latest, eurRate, eurStr, setEurStr, defaultEur, totalPln, today, onChanged }: {
  latest: Snap[]; eurRate: number; eurStr: string; setEurStr: (s: string) => void; defaultEur: number;
  totalPln: number; today: string; onChanged: () => Promise<void>;
}) {
  const [account, setAccount] = useState("");
  const [currency, setCurrency] = useState<"PLN" | "EUR">("PLN");
  const [amount, setAmount] = useState("");
  const [asOf, setAsOf] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function pick(name: string) {
    setAccount(name);
    const ex = latest.find((x) => x.account === name);
    if (ex) setCurrency(ex.currency);
  }
  async function save() {
    const a = num(amount);
    if (!account.trim()) { setErr("Podaj nazwę konta, np. „mBank PLN”."); return; }
    if (a == null) { setErr("Podaj saldo (liczba, może być ujemna)."); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase.from("cash_balances").insert({ account: account.trim(), currency, amount: a, as_of: asOf });
    setBusy(false);
    if (error) { setErr(/does not exist|schema cache/.test(error.message) ? "Brak tabeli sald kont — uruchom migrację 033_cash_balances.sql w Supabase Studio." : error.message); return; }
    setAmount("");
    await onChanged();
  }
  async function undo(id: string) {
    if (!confirm("Usunąć ten zapis salda? Poprzedni zapis tego konta znów będzie obowiązywał.")) return;
    const { error } = await supabase.from("cash_balances").delete().eq("id", id);
    if (error) setErr(error.message);
    await onChanged();
  }
  const age = (d: string) => Math.round((Date.parse(today + "T12:00:00Z") - Date.parse(d + "T12:00:00Z")) / 864e5);

  return (
    <div className="card space-y-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-slate-800">Salda kont</h2>
        <div className="text-slate-600">Gotówka razem: <b className="tabular-nums">{fmt0(totalPln)} zł</b></div>
      </div>
      {latest.length === 0 ? <div className="text-slate-400">Brak zapisanych sald. Dodaj saldo każdego konta poniżej; salda są pamiętane, więc wystarczy aktualizować je, gdy się zmienią.</div> : (
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500"><tr>
            <th className="text-left py-1">Konto</th><th className="text-right">Saldo</th><th className="text-right">Wartość zł</th><th className="text-left pl-4">Na dzień</th><th /></tr></thead>
          <tbody>
            {latest.map((x) => (
              <tr key={x.id} className="border-t border-slate-100">
                <td className="py-1.5">{x.account}</td>
                <td className="text-right tabular-nums">{fmt0(x.amount)} {x.currency}</td>
                <td className="text-right tabular-nums">{fmt0(x.currency === "EUR" ? x.amount * eurRate : x.amount)}</td>
                <td className={`pl-4 ${age(x.as_of) > 1 ? "text-amber-700" : "text-slate-500"}`}>{fmtDateFull(x.as_of)}{age(x.as_of) > 1 && ` (${age(x.as_of)} dni temu — zaktualizuj)`}</td>
                <td className="text-right"><button className="text-red-500 hover:underline text-xs" onClick={() => undo(x.id)}>cofnij zapis</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div><label className="label">Konto</label>
          <input className="input-field !w-44" list="cf-accounts" value={account} placeholder="np. mBank PLN" onChange={(e) => pick(e.target.value)} />
          <datalist id="cf-accounts">{latest.map((x) => <option key={x.id} value={x.account} />)}</datalist></div>
        <div><label className="label">Waluta</label>
          <select className="input-field !w-24" value={currency} onChange={(e) => setCurrency(e.target.value as "PLN" | "EUR")}><option>PLN</option><option>EUR</option></select></div>
        <div><label className="label">Saldo</label>
          <input className="input-field !w-36" inputMode="decimal" value={amount} placeholder="0,00" onChange={(e) => setAmount(e.target.value)} /></div>
        <div><label className="label">Na dzień</label>
          <input className="input-field !w-40" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
        <button className="btn-primary" disabled={busy} onClick={save}>{busy ? "Zapisuję…" : "Zapisz saldo"}</button>
        <div className="ml-auto"><label className="label">Kurs EUR/PLN</label>
          <input className="input-field !w-24" inputMode="decimal" value={eurStr} placeholder={String(defaultEur)} onChange={(e) => setEurStr(e.target.value)} /></div>
      </div>
      {err && <div className="text-red-600">{err}</div>}
      <div className="text-xs text-slate-400">Konto z kilkoma walutami zapisz jako osobne konta (np. „mBank PLN” i „mBank EUR”). Saldo ujemne (debet) wpisz ze znakiem minus. Kurs domyślnie pochodzi z ustawień aplikacji.</div>
    </div>
  );
}

function ReceivablesImport({ onDone }: { onDone: () => Promise<void> }) {
  const [rows, setRows] = useState<ReceivableRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setMsg(null); setFileName(f.name);
    const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true });
    const r = parseReceivablesWorkbook(wb);
    if (r.error) { setRows(null); setMsg({ ok: false, text: r.error }); return; }
    setRows(r.rows);
  }
  const open = rows?.filter((x) => (x.pozostalo_pln ?? 0) > 0.01) ?? [];

  async function save() {
    if (!rows) return;
    setBusy(true); setMsg(null);
    const stamp = new Date().toISOString();
    try {
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500).map((x) => ({ ...x, imported_at: stamp }));
        const { error } = await supabase.from("receivable_invoices").upsert(batch, { onConflict: "numer" });
        if (error) throw new Error(/does not exist|schema cache/.test(error.message) ? "Brak tabeli należności — uruchom migrację 032_cashflow.sql w Supabase Studio." : error.message);
      }
      setMsg({ ok: true, text: `Zapisano ${rows.length} faktur (otwartych: ${open.length}). Faktury nieobecne w pliku zostają bez zmian.` });
      setRows(null);
      await onDone();
    } catch (e) { setMsg({ ok: false, text: "Błąd importu: " + (e as Error).message }); }
    setBusy(false);
  }

  return (
    <div className="card space-y-3 text-sm">
      <h2 className="font-semibold text-slate-800">Import należności (rejestr faktur sprzedażowych z Rokos)</h2>
      <p className="text-slate-500">
        Wczytaj eksport „Rejestr faktur” z kolumnami Numer, Kontrahent, Termin płatności i Pozostało do zapłaty w PLN (najlepiej pełny, z dzisiejszym stanem).
        Faktury są aktualizowane po numerze, więc można wczytać też eksport częściowy. Faktury z kolumną Faktor = IFIS są liczone jako już sfinansowane.
      </p>
      <input type="file" accept=".xls,.xlsx,.ods" onChange={(e) => onFile(e.target.files?.[0])} />
      {fileName && <div className="text-xs text-slate-500">{fileName}</div>}
      {rows && (
        <div className="flex flex-wrap items-center gap-3">
          <span>{rows.length} faktur w pliku, w tym otwartych {open.length} na {fmt0(round2(open.reduce((s, x) => s + (x.pozostalo_pln ?? 0), 0)))} zł.</span>
          <button className="btn-primary" disabled={busy} onClick={save}>{busy ? "Zapisuję…" : "Zapisz do bazy"}</button>
        </div>
      )}
      {msg && <div className={msg.ok ? "text-emerald-700" : "text-red-600"}>{msg.text}</div>}
    </div>
  );
}
