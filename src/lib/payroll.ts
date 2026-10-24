// ============================================================
// payroll.ts — HBM TruckCalc, moduł /rozliczenia-kierowcow
// Czysta logika (bez dostępu do bazy): wyliczenia, walidacje, eksport
// zestawienia dla Ozar Trans w układzie pliku "wypłaty kierowcy <miesiąc>"
// oraz parser takiego pliku (import historyczny).
// Reguły walidacji wynikają z błędów znalezionych w pliku z czerwca 2026
// (potrącenie z plusem, 38 dni w 30-dniowym miesiącu, kwoty bez opisu).
// ============================================================

import * as XLSX from "xlsx";

export type PayrollRole = "editor" | "approver";
export type PeriodStatus = "otwarty" | "zgloszony" | "zatwierdzony" | "wyslany";
export type EntryKind = "credit" | "deduction";

export interface Person {
  id: string; first_name: string; last_name: string; sheet_name: string | null;
  active: boolean; note: string | null;
}
export interface Rate { id: string; person_id: string; day_rate: number; leave_rate: number; valid_from: string }
export interface Period {
  id: string; year: number; month: number; status: PeriodStatus; version: number;
  submitted_at: string | null; approved_at: string | null; sent_at: string | null; note: string | null;
}
export interface Line {
  id: string; period_id: string; person_id: string;
  days_worked: number; days_leave: number; days_sick: number; note: string | null;
}
export interface Entry {
  id: string; period_id: string; person_id: string; kind: EntryKind; category: string;
  description: string; basis: string | null; currency: "PLN" | "EUR";
  amount_orig: number; fx_rate: number; amount_pln: number; created_at?: string;
}

export const STATUS_LABELS: Record<PeriodStatus, string> = {
  otwarty: "Otwarty (wpisywanie)",
  zgloszony: "Zgłoszony do zatwierdzenia",
  zatwierdzony: "Zatwierdzony",
  wyslany: "Wysłany do Ozar",
};

export const DEFAULT_EUR_PLN = 4.3; // kurs użyty w pliku z czerwca 2026; edytowalny przy każdej pozycji

export const CREDIT_CATEGORIES = [
  "Załadunek / rozładunek",
  "Zwrot kosztów (nocleg, parking, opłaty)",
  "Premia / inne uznanie",
];
export const DEDUCTION_CATEGORIES = [
  "Tankowanie na karcie",
  "Brak NIP / VAT na paragonie",
  "Szkoda w mieniu",
  "Mandat / kara",
  "Zaliczka",
  "Inne potrącenie",
];

const MONTHS = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
export const periodLabel = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;
export const fullName = (p: Person) => `${p.last_name} ${p.first_name}`.trim();

/** Stawka obowiązująca w miesiącu: najnowsza z valid_from <= 1. dzień miesiąca. */
export function rateFor(rates: Rate[], personId: string, y: number, m: number): Rate | null {
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  let best: Rate | null = null;
  for (const r of rates) {
    if (r.person_id !== personId || r.valid_from > first) continue;
    if (!best || r.valid_from > best.valid_from) best = r;
  }
  return best;
}

export interface LineCalc {
  workAmount: number | null; leaveAmount: number | null;
  credits: number; deductions: number; total: number | null;
}
export function computeLine(
  line: Pick<Line, "days_worked" | "days_leave"> | undefined,
  entries: Entry[],
  rate: { day_rate: number; leave_rate: number } | null,
): LineCalc {
  const credits = round2(entries.filter((e) => e.kind === "credit").reduce((s, e) => s + e.amount_pln, 0));
  const deductions = round2(entries.filter((e) => e.kind === "deduction").reduce((s, e) => s + e.amount_pln, 0));
  if (!rate) return { workAmount: null, leaveAmount: null, credits, deductions, total: null };
  const workAmount = round2((line?.days_worked ?? 0) * rate.day_rate);
  const leaveAmount = round2((line?.days_leave ?? 0) * rate.leave_rate);
  return { workAmount, leaveAmount, credits, deductions, total: round2(workAmount + leaveAmount + credits + deductions) };
}

// ── Sugestia dni pracy z Rokos (rejestr transportów) ──────────
// Dzień = dzień objęty zleceniem kierowcy (od podjęcia do dostawy, daty
// rzeczywiste, a gdy ich brak — planowane). Przerwy do GAP_FILL_DAYS dni
// między dniami ze zleceniem są wypełniane (postój przed załadunkiem, weekend
// po rozładunku). Reguła sprawdzona na wypłatach za czerwiec 2026: dokładnie
// zgodna u 40 z 55 kierowców, w granicach ±1 dzień u 48. Urlopów i chorobowego
// Rokos nie zna — to sugestia do porównania z wpisem, nie zastępuje go.
export const GAP_FILL_DAYS = 2;
export const SUGGESTION_TOLERANCE = 2;

export interface RokosOrder {
  order_number: string | null; driver_name: string | null;
  pickup_date: string | null; delivery_date: string | null;
  pickup_actual: string | null; delivery_actual: string | null;
  carrier_name?: string | null; // przewoźnik zlecenia; kierowcy podwykonawców nie są rozliczani
  created_at?: string | null;
}
export interface DaySuggestion { days: number; filled: number; orders: number; first: string; last: string }

const addDaysIso = (s: string, n: number) => {
  const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
export function nameTokens(s: string): string[] {
  return s.toUpperCase().replace(/Ł/g, "L").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean);
}
function lev(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Dopasowanie nazwy kierowcy z Rokos ("NAZWISKO IMIĘ") do osoby: najpierw zbiór słów, potem literówka (1 znak). */
export function makePersonMatcher(people: Person[]): (driverName: string) => Person | null {
  const keyOf = (t: string[]) => [...t].sort().join(" ");
  const exact = new Map<string, Person | null>();
  const toks = people.map((p) => ({ p, t: nameTokens(`${p.last_name} ${p.first_name}`) }));
  toks.forEach(({ p, t }) => { const k = keyOf(t); exact.set(k, exact.has(k) ? null : p); });
  const cache = new Map<string, Person | null>();
  return (driverName: string) => {
    if (cache.has(driverName)) return cache.get(driverName)!;
    const t = nameTokens(driverName);
    let hit: Person | null = exact.get(keyOf(t)) ?? null;
    if (!hit && t.length >= 2) {
      const cands = toks.filter((x) => x.t.length === t.length && (() => {
        const rest = [...x.t];
        return t.every((w) => {
          const i = rest.findIndex((r) => r === w || (w.length >= 5 && r.length >= 5 && lev(r, w) <= 1));
          if (i < 0) return false; rest.splice(i, 1); return true;
        });
      })());
      if (cands.length === 1) hit = cands[0].p;
    }
    cache.set(driverName, hit);
    return hit;
  };
}

export function suggestDays(orders: RokosOrder[], people: Person[], year: number, month: number): {
  byPerson: Map<string, DaySuggestion>; unmatched: { name: string; days: number }[];
} {
  const m0 = firstOfMonth(year, month), m1 = lastOfMonth(year, month);
  const match = makePersonMatcher(people);
  const groups = new Map<string, { person: Person | null; name: string; days: Set<string>; orders: number }>();
  for (const o of orders) {
    if (!o.driver_name) continue;
    if (o.carrier_name && !/B&M.{0,2}INVEST/i.test(o.carrier_name)) continue; // podwykonawca
    const a = o.pickup_actual ?? o.pickup_date;
    if (!a) continue;
    let b = o.delivery_actual ?? o.delivery_date ?? a;
    if (b < a) b = a;
    if (b < m0 || a > m1) continue;
    const person = match(o.driver_name);
    const key = person ? person.id : "?" + nameTokens(o.driver_name).sort().join(" ");
    const g = groups.get(key) ?? { person, name: o.driver_name.trim(), days: new Set<string>(), orders: 0 };
    for (let d = a < m0 ? m0 : a; d <= (b > m1 ? m1 : b); d = addDaysIso(d, 1)) g.days.add(d);
    g.orders++;
    groups.set(key, g);
  }
  const byPerson = new Map<string, DaySuggestion>();
  const unmatched: { name: string; days: number }[] = [];
  groups.forEach((g) => {
    const sorted = [...g.days].sort();
    const all = new Set(sorted);
    for (let i = 1; i < sorted.length; i++) {
      const gap = Math.round((Date.parse(sorted[i]) - Date.parse(sorted[i - 1])) / 864e5) - 1;
      if (gap > 0 && gap <= GAP_FILL_DAYS) for (let k = 1; k <= gap; k++) all.add(addDaysIso(sorted[i - 1], k));
    }
    if (g.person) byPerson.set(g.person.id, { days: all.size, filled: all.size - sorted.length, orders: g.orders, first: sorted[0], last: sorted[sorted.length - 1] });
    else unmatched.push({ name: g.name, days: all.size });
  });
  unmatched.sort((x, y) => y.days - x.days);
  return { byPerson, unmatched };
}
export const firstOfMonth = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;
export const lastOfMonth = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth(y, m)).padStart(2, "0")}`;

// ── Walidacje ────────────────────────────────────────────────
export interface Issue { level: "error" | "warn"; personId?: string; text: string }

export function validatePeriod(args: {
  period: Period; people: Person[]; lines: Line[]; entries: Entry[];
  rateOf: ((personId: string) => { day_rate: number; leave_rate: number } | null) | null; // null = brak wglądu w stawki
  suggestions?: Map<string, DaySuggestion>; // sugestia dni z Rokos (opcjonalna)
}): Issue[] {
  const { period, people, lines, entries, rateOf, suggestions } = args;
  const dim = daysInMonth(period.year, period.month);
  const out: Issue[] = [];
  const lineBy = new Map(lines.map((l) => [l.person_id, l]));
  for (const p of people) {
    const l = lineBy.get(p.id);
    const es = entries.filter((e) => e.person_id === p.id);
    const name = fullName(p);
    if (!p.active && !l && es.length === 0) continue;
    const sug = suggestions?.get(p.id);
    if (!l) {
      if (p.active) out.push({ level: "warn", personId: p.id, text: `${name}: nie wpisano dni${sug ? ` (Rokos: ${sug.days} dni ze ${sug.orders} zleceń)` : " (jeśli kierowca nie pracował w tym miesiącu, wpisz 0)"}.` });
      continue;
    }
    const sum = l.days_worked + l.days_leave + l.days_sick;
    if (sug && Math.abs(l.days_worked - sug.days) > SUGGESTION_TOLERANCE)
      out.push({ level: "warn", personId: p.id, text: `${name}: wpisano ${l.days_worked} dni pracy, a Rokos sugeruje ${sug.days} (${sug.orders} zleceń). Sprawdź urlop, chorobowe lub zlecenia.` });
    if (!sug && l.days_worked > 0 && suggestions && suggestions.size > 0)
      out.push({ level: "warn", personId: p.id, text: `${name}: wpisano ${l.days_worked} dni pracy, a w Rokos nie ma zleceń tego kierowcy w tym miesiącu.` });
    if (sum > dim) out.push({ level: "error", personId: p.id, text: `${name}: dni pracy + urlop + chorobowe = ${sum}, a miesiąc ma ${dim} dni.` });
    if (l.days_sick > 0) out.push({ level: "warn", personId: p.id, text: `${name}: ${l.days_sick} dni chorobowego. W wyliczeniu są nieodpłatne — potwierdź z Ozar, kto je płaci.` });
    if (sum === 0 && es.length > 0) out.push({ level: "warn", personId: p.id, text: `${name}: pozycje uznań/potrąceń przy 0 dni.` });
    for (const e of es) {
      if (e.kind === "deduction" && /^do uzupełnienia/i.test((e.basis ?? "").trim()))
        out.push({ level: "warn", personId: p.id, text: `${name}: potrącenie „${e.description.slice(0, 50)}” ma niepełną podstawę (do uzupełnienia).` });
    }
    const seen = new Set<string>();
    for (const e of es) {
      const k = [e.kind, e.category, e.amount_orig, e.description.trim().toLowerCase()].join("|");
      if (seen.has(k)) out.push({ level: "warn", personId: p.id, text: `${name}: możliwy duplikat pozycji „${e.description.slice(0, 50)}” (${e.amount_orig} ${e.currency}).` });
      seen.add(k);
    }
    if (rateOf) {
      const rate = rateOf(p.id);
      if (!rate && sum > 0) out.push({ level: "error", personId: p.id, text: `${name}: brak stawki obowiązującej w tym miesiącu.` });
      const c = computeLine(l, es, rate);
      if (c.total !== null && c.total < 0) out.push({ level: "error", personId: p.id, text: `${name}: ujemna kwota do wypłaty (${c.total.toFixed(2)} zł) — potrącenia przekraczają należność.` });
    }
  }
  return out;
}

// ── Eksport dla Ozar Trans ───────────────────────────────────
export function ozarFileName(period: Period, ext: "ods" | "xlsx"): string {
  const m = periodLabel(period.year, period.month);
  const v = period.version > 1 ? ` (wersja ${period.version})` : "";
  return `wypłaty kierowcy ${m}${v}.${ext}`;
}

const pl2 = (n: number) => n.toFixed(2).replace(".", ",");
function entryText(e: Entry): string {
  const base = e.currency === "EUR" ? `${e.description} [${pl2(e.amount_orig)} EUR × ${e.fx_rate.toFixed(2).replace(".", ",")}]` : e.description;
  return e.kind === "deduction" && e.basis ? `${base} (podstawa: ${e.basis})` : base;
}
function safeSheetName(base: string, used: Set<string>): string {
  const clean = base.replace(/[\[\]:*?/\\]/g, "").replace(/\s+/g, "_").slice(0, 31) || "kierowca";
  let name = clean, i = 2;
  while (used.has(name.toLowerCase())) { const suf = `_${i++}`; name = clean.slice(0, 31 - suf.length) + suf; }
  used.add(name.toLowerCase());
  return name;
}
const S = (v: string): XLSX.CellObject => ({ t: "s", v });
const N = (v: number, f?: string): XLSX.CellObject => (f ? { t: "n", v, f } : { t: "n", v });

export interface ExportInput {
  period: Period; people: Person[]; lines: Line[]; entries: Entry[];
  rateOf: (personId: string) => { day_rate: number; leave_rate: number } | null;
  draft: boolean;
}

/** Skoroszyt w układzie pliku z czerwca: arkusz na kierowcę (te same komórki: K4, K5, S4, S5, T7, U7, R10, S10, K9, K14, Q13) + RAZEM. */
export function buildOzarWorkbook(inp: ExportInput): XLSX.WorkBook {
  const { period, people, lines, entries, rateOf, draft } = inp;
  const wb = XLSX.utils.book_new();
  const used = new Set<string>(["razem"]);
  const rows: { name: string; calc: LineCalc; line: Line; rate: { day_rate: number; leave_rate: number } }[] = [];
  const lineBy = new Map(lines.map((l) => [l.person_id, l]));
  const sorted = [...people].sort((a, b) => fullName(a).localeCompare(fullName(b), "pl"));

  for (const p of sorted) {
    const line = lineBy.get(p.id);
    const es = entries.filter((e) => e.person_id === p.id);
    if (!line || (line.days_worked + line.days_leave + line.days_sick === 0 && es.length === 0)) continue;
    const rate = rateOf(p.id);
    if (!rate) throw new Error(`Brak stawki dla ${fullName(p)} — uzupełnij ją przed eksportem.`);
    const credits = es.filter((e) => e.kind === "credit"), deds = es.filter((e) => e.kind === "deduction");
    const calc = computeLine(line, es, rate);

    const ws: XLSX.WorkSheet = {};
    ws["J2"] = S("ROZLICZENIE WYPŁATY ");
    ws["Q2"] = S(periodLabel(period.year, period.month) + (draft ? "  — WERSJA ROBOCZA" : period.version > 1 ? `  — wersja ${period.version}` : ""));
    ws["J4"] = S("IMIĘ:"); ws["K4"] = S(p.first_name);
    ws["J5"] = S("NAZWISKO:"); ws["K5"] = S(p.last_name);
    ws["Q4"] = S("STAWKA- PRZEPRACOWANY DZIEŃ:"); ws["S4"] = N(rate.day_rate); ws["T4"] = S("pln za przepracowany dzień");
    ws["Q5"] = S("STAWKA- URLOP WYPOCZYNKOWY:"); ws["S5"] = N(rate.leave_rate); ws["T5"] = S("pln za dzień urlopu");
    ws["M7"] = S("OPIS");
    ws["R7"] = S("ILOŚĆ PRZEPRACOWANYCH DNI"); ws["T7"] = N(line.days_worked); ws["U7"] = N(calc.workAmount ?? 0, "S4*T7");
    ws["K8"] = S("KWOTA"); ws["L8"] = S(credits.map(entryText).join("; "));
    ws["J9"] = S("UZNANIA/ ZWROTY"); ws["K9"] = N(calc.credits, credits.length ? `SUM(K18:K${17 + credits.length})` : undefined);
    if (!credits.length) ws["K9"] = N(0);
    ws["S9"] = S("ILOŚĆ "); ws["T9"] = S("KWOTA");
    ws["P10"] = S("ILOŚĆ DNI NA URLOPIE WYPOCZYNKOWYM "); ws["R10"] = N(line.days_leave); ws["S10"] = N(calc.leaveAmount ?? 0, "S5*R10");
    if (line.days_sick > 0) { ws["P11"] = S("ILOŚĆ DNI CHOROBOWEGO (poza wyliczeniem) "); ws["R11"] = N(line.days_sick); }
    ws["M12"] = S("OPIS");
    ws["K13"] = S("KWOTA"); ws["L13"] = S(deds.map(entryText).join("; "));
    ws["O13"] = S("RAZEM:"); ws["Q13"] = N(calc.total ?? 0, "U7+S10+K9+K14");
    ws["J14"] = S("OBCIĄŻENIA/ MANDATY");
    const dStart = 18 + credits.length + 2;
    ws["K14"] = deds.length ? N(calc.deductions, `SUM(K${dStart + 1}:K${dStart + deds.length})`) : N(0);
    if (line.note) { ws["J15"] = S("UWAGA:"); ws["K15"] = S(line.note); }

    // szczegóły pozycji (jedna pozycja = jedna linia) — do weryfikacji po stronie Ozar
    ws["J17"] = S("SZCZEGÓŁY: UZNANIA"); ws["K17"] = S("KWOTA PLN"); ws["L17"] = S("OPIS");
    credits.forEach((e, i) => { ws[`J${18 + i}`] = S(e.category); ws[`K${18 + i}`] = N(e.amount_pln); ws[`L${18 + i}`] = S(entryText(e)); });
    ws[`J${dStart}`] = S("SZCZEGÓŁY: OBCIĄŻENIA"); ws[`K${dStart}`] = S("KWOTA PLN"); ws[`L${dStart}`] = S("OPIS");
    deds.forEach((e, i) => { ws[`J${dStart + 1 + i}`] = S(e.category); ws[`K${dStart + 1 + i}`] = N(e.amount_pln); ws[`L${dStart + 1 + i}`] = S(entryText(e)); });

    ws["!ref"] = `J2:V${Math.max(dStart + deds.length, 18 + credits.length)}`;
    ws["!cols"] = Array.from({ length: 22 }, (_, i) => ({ wch: i === 9 ? 26 : i === 10 ? 14 : i === 11 ? 60 : i >= 14 && i <= 17 ? 16 : 11 }));
    const sheetName = safeSheetName(p.sheet_name ?? `${p.last_name}_${p.first_name}`, used);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    rows.push({ name: sheetName, calc, line, rate });
  }

  // RAZEM — tabela zbiorcza z formułami sumującymi
  const header = ["Kierowca (arkusz)", "Stawka za dzień", "Dni pracy", "Kwota za dni", "Stawka za urlop", "Dni urlopu", "Kwota za urlop", "Uznania/zwroty", "Obciążenia/mandaty", "RAZEM do wypłaty (netto)"];
  const aoa: (string | number)[][] = [
    [`RAZEM — ${periodLabel(period.year, period.month)}${draft ? " (WERSJA ROBOCZA)" : period.version > 1 ? ` (wersja ${period.version})` : ""}`], [], header,
    ...rows.map((r) => [r.name]),
  ];
  const wsT = XLSX.utils.aoa_to_sheet(aoa);
  const first = 4, last = 3 + rows.length;
  rows.forEach((r, i) => {
    const n = first + i;
    wsT[`B${n}`] = N(r.rate.day_rate);
    wsT[`C${n}`] = N(r.line.days_worked);
    wsT[`D${n}`] = N(r.calc.workAmount ?? 0, `B${n}*C${n}`);
    wsT[`E${n}`] = N(r.rate.leave_rate);
    wsT[`F${n}`] = N(r.line.days_leave);
    wsT[`G${n}`] = N(r.calc.leaveAmount ?? 0, `E${n}*F${n}`);
    wsT[`H${n}`] = N(r.calc.credits);
    wsT[`I${n}`] = N(r.calc.deductions);
    wsT[`J${n}`] = N(r.calc.total ?? 0, `D${n}+G${n}+H${n}+I${n}`);
  });
  const tr = last + 1;
  const sumOf = (k: (r: (typeof rows)[number]) => number) => round2(rows.reduce((s, r) => s + k(r), 0));
  wsT[`A${tr}`] = S("RAZEM:");
  const col = (c: string, v: number) => { wsT[`${c}${tr}`] = N(v, `SUM(${c}${first}:${c}${last})`); };
  col("C", sumOf((r) => r.line.days_worked)); col("D", sumOf((r) => r.calc.workAmount ?? 0));
  col("F", sumOf((r) => r.line.days_leave)); col("G", sumOf((r) => r.calc.leaveAmount ?? 0));
  col("H", sumOf((r) => r.calc.credits)); col("I", sumOf((r) => r.calc.deductions)); col("J", sumOf((r) => r.calc.total ?? 0));
  wsT["!ref"] = `A1:J${tr}`;
  wsT["!cols"] = [{ wch: 30 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, wsT, "RAZEM");
  return wb;
}

export function workbookTotal(wb: XLSX.WorkBook): number {
  const ws = wb.Sheets["RAZEM"];
  const ref = XLSX.utils.decode_range(ws["!ref"]!);
  const c = ws[`J${ref.e.r + 1}`];
  return c ? (c.v as number) : 0;
}

// ── Parser pliku historycznego (import) ──────────────────────
export interface ImportRow {
  sheet: string; first: string; last: string;
  dayRate: number | null; leaveRate: number | null;
  days: number; leave: number;
  credits: number; creditsText: string; deductions: number; deductionsText: string;
  total: number | null; issues: string[]; blocking: boolean; empty: boolean;
}
const cellNum = (ws: XLSX.WorkSheet, a: string): number | null => (typeof ws[a]?.v === "number" ? (ws[a].v as number) : null);
const cellStr = (ws: XLSX.WorkSheet, a: string): string => (ws[a]?.v == null ? "" : String(ws[a].v).trim());

export function parseSettlementWorkbook(wb: XLSX.WorkBook, year: number, month: number): ImportRow[] {
  const dim = daysInMonth(year, month);
  const out: ImportRow[] = [];
  for (const name of wb.SheetNames) {
    if (name.trim().toUpperCase() === "RAZEM") continue;
    const ws = wb.Sheets[name];
    // Arkusz rozliczenia kierowcy ma stały układ: nagłówek w J2 i etykieta „IMIĘ:” w J4.
    // Inne arkusze (np. rejestr transportów) pomijamy, zamiast czytać z nich przypadkowe komórki.
    if (!/ROZLICZENIE\s+WYP[ŁL]ATY/i.test(cellStr(ws, "J2")) || !/^IMI/i.test(cellStr(ws, "J4"))) continue;
    const dayRate = cellNum(ws, "S4"), leaveRate = cellNum(ws, "S5");
    const days = cellNum(ws, "T7") ?? 0, leave = cellNum(ws, "R10") ?? 0;
    const credits = cellNum(ws, "K9") ?? 0, deductions = cellNum(ws, "K14") ?? 0;
    const creditsText = cellStr(ws, "L8"), deductionsText = cellStr(ws, "L13");
    const total = cellNum(ws, "Q13");
    const empty = !cellStr(ws, "K4") && !cellStr(ws, "K5") && days === 0 && leave === 0 && credits === 0 && deductions === 0;
    const issues: string[] = [];
    let blocking = false;
    if (days + leave > dim) { issues.push(`dni pracy + urlop = ${days + leave}, a miesiąc ma ${dim} dni`); blocking = true; }
    if (deductions > 0) { issues.push(`obciążenie ma znak dodatni (+${deductions}) — powinno być ujemne; pozycji nie importuję, popraw ręcznie`); blocking = true; }
    if (credits < 0) { issues.push(`uznanie ma znak ujemny (${credits})`); blocking = true; }
    if (creditsText && credits === 0) issues.push(`opis uznania bez kwoty: „${creditsText.slice(0, 40)}”`);
    if (deductionsText && !/^brak$/i.test(deductionsText) && deductions === 0) issues.push(`opis obciążenia bez kwoty: „${deductionsText.slice(0, 40)}”`);
    if ((days > 0 || leave > 0) && (dayRate == null || leaveRate == null)) { issues.push("brak stawki w arkuszu"); blocking = true; }
    if ((dayRate != null && (dayRate < 50 || dayRate > 1500)) || (leaveRate != null && (leaveRate < 50 || leaveRate > 1500))) {
      issues.push(`nietypowa stawka (${dayRate} / ${leaveRate} zł) — sprawdź arkusz`); blocking = true;
    }
    if (total != null && dayRate != null && leaveRate != null) {
      const calc = round2(days * dayRate + leave * leaveRate + credits + deductions);
      if (Math.abs(calc - total) > 0.5) issues.push(`suma w pliku ${total} ≠ wyliczona ${calc}`);
    }
    out.push({ sheet: name, first: cellStr(ws, "K4"), last: cellStr(ws, "K5"), dayRate, leaveRate, days, leave, credits, creditsText, deductions, deductionsText, total, issues, blocking, empty });
  }
  return out;
}
