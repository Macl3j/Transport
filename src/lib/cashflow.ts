// ============================================================
// cashflow.ts — HBM TruckCalc, strona /cashflow
// Czysta logika (bez bazy): tygodniowy plan zobowiązań i należności z faktur,
// opłata faktora IFIS oraz parser rejestru faktur sprzedażowych z Rokos.
//
// Zasady (ustalone z zarządem):
//  * zobowiązania = faktury kosztowe B&M z kwotą pozostałą do zapłaty, wg terminu
//    płatności; faktury odbiorcy KRAVTT (odrębna spółka) nie są liczone,
//  * należności = faktury sprzedażowe z kwotą pozostałą do zapłaty, wg terminu
//    płatności klienta,
//  * faktura sfinansowana przez IFIS: IFIS wpłaca całość przy finansowaniu, więc
//    to nie jest przyszły wpływ gotówki. Zostaje opłata 0,5% za każde 30 dni
//    finansowania, do chwili wpłaty klienta na konto IFIS (szacujemy ją na termin
//    klienta, a dla faktur po terminie — do dziś),
//  * faktury po terminie to osobny wiersz; użytkownik decyduje, w ilu tygodniach
//    założyć ich zapłatę/wpływ (0 = nie wliczaj do salda tygodniowego).
// ============================================================

import * as XLSX from "xlsx";

export interface PayInvoice { numer: string; kontrahent: string; termin: string; kwota: number; kategoria: string | null }
export interface RecvInvoice { numer: string; kontrahent: string; termin: string; wystawiona: string | null; kwota: number; faktor: string | null }

export const IFIS_RATE_PER_30D = 0.005;
export const IFIS_NAME = "IFIS";

export interface CashflowOptions {
  today: string;            // YYYY-MM-DD
  weeks: number;            // ile tygodni w tabeli
  overduePayWeeks: number;  // w ilu tygodniach rozłożyć zaległe zobowiązania (0 = osobno, poza saldem)
  overdueRecvWeeks: number; // w ilu tygodniach rozłożyć zaległe należności (0 = osobno, poza saldem)
  opening: number;          // stan gotówki na dziś
  ifisPerStarted: boolean;  // opłata IFIS za każde rozpoczęte 30 dni (true) czy proporcjonalnie (false)
}

export interface WeekRow {
  idx: number; start: string; end: string;
  payN: number; paySum: number; spreadPay: number;
  recvN: number; recvSum: number; spreadRecv: number;
  ifisN: number; ifisFee: number;
  net: number; cum: number;
  payItems: PayInvoice[]; recvItems: RecvInvoice[]; ifisItems: { inv: RecvInvoice; fee: number }[];
}
export interface Bucket { payN: number; paySum: number; recvN: number; recvSum: number }
export interface CashflowResult {
  overdue: Bucket & { payItems: PayInvoice[]; recvItems: RecvInvoice[] };
  weeks: WeekRow[];
  later: Bucket & { payItems: PayInvoice[]; recvItems: RecvInvoice[] };
  ifis: { n: number; base: number; fee: number; overdueN: number; overdueBase: number };
  totals: { payN: number; paySum: number; recvN: number; recvSum: number; ifisFee: number };
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const DAY = 864e5;
export const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / DAY);
export const mondayOf = (s: string) => { const k = (new Date(s + "T12:00:00Z").getUTCDay() + 6) % 7; return addDays(s, -k); };

/** Opłata IFIS: 0,5% za 30 dni finansowania od wystawienia do wpłaty klienta (termin lub dziś, jeśli po terminie). */
export function ifisFee(inv: RecvInvoice, today: string, perStarted: boolean): number {
  const start = inv.wystawiona ?? today;
  const end = inv.termin < today ? today : inv.termin;
  const days = Math.max(0, daysBetween(start, end));
  const periods = perStarted ? Math.ceil(days / 30) : days / 30;
  return round2(inv.kwota * IFIS_RATE_PER_30D * periods);
}

export function buildCashflow(pay: PayInvoice[], recv: RecvInvoice[], o: CashflowOptions): CashflowResult {
  const w0 = mondayOf(o.today);
  const weeks: WeekRow[] = Array.from({ length: o.weeks }, (_, i) => ({
    idx: i, start: addDays(w0, i * 7), end: addDays(w0, i * 7 + 6),
    payN: 0, paySum: 0, spreadPay: 0, recvN: 0, recvSum: 0, spreadRecv: 0, ifisN: 0, ifisFee: 0,
    net: 0, cum: 0, payItems: [], recvItems: [], ifisItems: [],
  }));
  const empty = () => ({ payN: 0, paySum: 0, recvN: 0, recvSum: 0, payItems: [] as PayInvoice[], recvItems: [] as RecvInvoice[] });
  const overdue = empty(), later = empty();
  const where = (d: string) => (d < o.today ? "over" : Math.floor(daysBetween(w0, d) / 7) >= o.weeks ? "later" : Math.floor(daysBetween(w0, d) / 7));

  for (const p of pay) {
    const w = where(p.termin);
    if (w === "over") { overdue.payN++; overdue.paySum += p.kwota; overdue.payItems.push(p); }
    else if (w === "later") { later.payN++; later.paySum += p.kwota; later.payItems.push(p); }
    else { const r = weeks[w]; r.payN++; r.paySum += p.kwota; r.payItems.push(p); }
  }
  const ifis = { n: 0, base: 0, fee: 0, overdueN: 0, overdueBase: 0 };
  for (const c of recv) {
    if ((c.faktor ?? "").toUpperCase() === IFIS_NAME) {
      const fee = ifisFee(c, o.today, o.ifisPerStarted);
      ifis.n++; ifis.base += c.kwota; ifis.fee += fee;
      if (c.termin < o.today) { ifis.overdueN++; ifis.overdueBase += c.kwota; }
      const w = c.termin < o.today ? 0 : where(c.termin);
      if (w !== "later" && w !== "over") { const r = weeks[w]; r.ifisN++; r.ifisFee += fee; r.ifisItems.push({ inv: c, fee }); }
      continue; // gotówka już wpłynęła od IFIS przy finansowaniu
    }
    const w = where(c.termin);
    if (w === "over") { overdue.recvN++; overdue.recvSum += c.kwota; overdue.recvItems.push(c); }
    else if (w === "later") { later.recvN++; later.recvSum += c.kwota; later.recvItems.push(c); }
    else { const r = weeks[w]; r.recvN++; r.recvSum += c.kwota; r.recvItems.push(c); }
  }

  // rozłożenie zaległości na kolejne tygodnie (założenie użytkownika)
  const np = Math.min(o.overduePayWeeks, o.weeks), nr = Math.min(o.overdueRecvWeeks, o.weeks);
  for (let i = 0; i < np; i++) weeks[i].spreadPay = overdue.paySum / np;
  for (let i = 0; i < nr; i++) weeks[i].spreadRecv = overdue.recvSum / nr;

  let cum = o.opening;
  for (const w of weeks) {
    w.paySum = round2(w.paySum); w.recvSum = round2(w.recvSum); w.ifisFee = round2(w.ifisFee);
    w.spreadPay = round2(w.spreadPay); w.spreadRecv = round2(w.spreadRecv);
    w.net = round2(w.recvSum + w.spreadRecv - w.paySum - w.spreadPay - w.ifisFee);
    cum = round2(cum + w.net); w.cum = cum;
  }
  overdue.paySum = round2(overdue.paySum); overdue.recvSum = round2(overdue.recvSum);
  later.paySum = round2(later.paySum); later.recvSum = round2(later.recvSum);
  ifis.base = round2(ifis.base); ifis.fee = round2(ifis.fee); ifis.overdueBase = round2(ifis.overdueBase);

  const all = <K extends "payN" | "paySum" | "recvN" | "recvSum">(k: K) => overdue[k] + later[k] + weeks.reduce((s, w) => s + w[k], 0);
  return {
    overdue, weeks, later, ifis,
    totals: { payN: all("payN"), paySum: round2(all("paySum")), recvN: all("recvN"), recvSum: round2(all("recvSum")), ifisFee: ifis.fee },
  };
}

// ── Parser rejestru faktur sprzedażowych (Rokos „Rejestr faktur”) ─────────
export interface ReceivableRow {
  numer: string; typ: string | null; data_wystawienia: string | null; termin_platnosci: string | null;
  kontrahent: string | null; brutto_pln: number | null; pozostalo_pln: number | null;
  status_platnosci: string | null; faktor: string | null; firma: string | null;
}
const str = (v: unknown): string | null => { const s = v == null ? "" : String(v).trim(); return s === "" ? null : s; };
const nm = (v: unknown): number | null => {
  if (typeof v === "number") return isNaN(v) ? null : v;
  const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return isNaN(n) ? null : n;
};
const isoLocal = (v: unknown): string | null => {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

export function parseReceivablesWorkbook(wb: XLSX.WorkBook): { rows: ReceivableRow[]; skipped: number; error?: string } {
  const ws = wb.Sheets[wb.SheetNames.includes("Sheet") ? "Sheet" : wb.SheetNames[0]];
  const objs = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
  const need = ["Numer", "Kontrahent", "Termin płatności", "Pozostało do zapłaty w PLN"];
  const keys = new Set(Object.keys(objs[0] ?? {}));
  const missing = need.filter((k) => !keys.has(k));
  if (missing.length > 0) return { rows: [], skipped: 0, error: `To nie wygląda na rejestr faktur sprzedażowych — brak kolumn: ${missing.join(", ")}.` };
  const rows: ReceivableRow[] = [];
  let skipped = 0;
  for (const r of objs) {
    const numer = str(r["Numer"]);
    if (!numer) { skipped++; continue; } // wiersz sum na dole eksportu
    rows.push({
      numer, typ: str(r["Typ"]), data_wystawienia: isoLocal(r["Data wystawienia"]), termin_platnosci: isoLocal(r["Termin płatności"]),
      kontrahent: str(r["Kontrahent"]), brutto_pln: nm(r["Brutto PLN"]), pozostalo_pln: nm(r["Pozostało do zapłaty w PLN"]),
      status_platnosci: str(r["Status płatności"]), faktor: str(r["Faktor"]), firma: str(r["Firma"]),
    });
  }
  return { rows, skipped };
}
