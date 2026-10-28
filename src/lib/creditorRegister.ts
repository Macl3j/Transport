// ============================================================
// creditorRegister.ts — Windykacja: porównanie wierzycieli z rejestrem faktur kosztowych.
// Wierzyciele na liście są prowadzeni ręcznie (creditors.total_amount_pln), a rejestr
// faktur (cost_invoices) jest importowany z Rokos. Ten moduł dopasowuje wierzyciela do
// sprzedawców z rejestru po nazwie i liczy, ile faktur jest otwartych i po terminie.
// ============================================================

export interface RegInvoice { numer: string; sprzedawca: string; termin: string | null; kwota: number }

const LEGAL = [
  "SPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA", "SPOLKA KOMANDYTOWA", "SPOLKA AKCYJNA", "SPOLKA JAWNA", "SPOLKA CYWILNA",
  "SP Z O O", "SP Z OO", "SPZOO", "SP K", "SP J", "S A", "S R O", "SARL", "GMBH", "LTD", "B V", "N V", "S L", "S R L",
];
// słowa zbyt ogólne, żeby same wystarczyły do dopasowania ("Polska", "Trans"…)
const GENERIC = new Set(["POLSKA", "POLAND", "TRANS", "TRANSPORT", "LOGISTICS", "LOGISTIC", "SERVICE", "SERVICES", "GROUP", "INTERNATIONAL", "SPEDYCJA", "FIRMA", "HANDEL", "USLUGI", "PRZEDSIEBIORSTWO", "EUROPE", "EUROPA"]);

export function normName(s: string): string {
  let t = s.toUpperCase().replace(/Ł/g, "L").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]+/g, " ").trim();
  t = ` ${t} `;
  for (const l of LEGAL) t = t.split(` ${l} `).join(" ");
  // formy prawne mogą być doklejone na końcu kilka razy (np. "SPOLKA AKCYJNA SPOLKA KOMANDYTOWA")
  for (const l of LEGAL) t = t.split(` ${l} `).join(" ");
  return t.replace(/\s+/g, " ").trim();
}

const tokens = (n: string) => n.split(" ").filter(Boolean);
const tokenMatches = (t: string, u: string) => u === t || (t.length >= 4 && u.startsWith(t));

/** Czy sprzedawca z rejestru to ten sam podmiot co wierzyciel z listy (po nazwie, bez form prawnych). */
export function sameParty(creditorName: string, vendorName: string): boolean {
  const a = normName(creditorName), b = normName(vendorName);
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = tokens(a), tb = tokens(b);
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const meaningful = short.filter((t) => !GENERIC.has(t));
  if (meaningful.length === 0 || !meaningful.some((t) => t.length >= 3)) return false;
  return meaningful.every((t) => long.some((u) => tokenMatches(t, u)));
}

export interface RegStats {
  n: number; total: number; overdue: number; overdueN: number; maxDaysOverdue: number;
  vendors: string[]; items: RegInvoice[];
}
const DAY = 864e5;
export function registerStats(creditorName: string, invoices: RegInvoice[], today: string): RegStats {
  const items = invoices.filter((i) => sameParty(creditorName, i.sprzedawca));
  let total = 0, overdue = 0, overdueN = 0, maxDays = 0;
  for (const i of items) {
    total += i.kwota;
    if (i.termin && i.termin < today) {
      overdue += i.kwota; overdueN++;
      maxDays = Math.max(maxDays, Math.round((Date.parse(today + "T12:00:00Z") - Date.parse(i.termin + "T12:00:00Z")) / DAY));
    }
  }
  return {
    n: items.length, total: Math.round(total * 100) / 100, overdue: Math.round(overdue * 100) / 100, overdueN, maxDaysOverdue: maxDays,
    vendors: [...new Set(items.map((i) => i.sprzedawca.trim()))], items,
  };
}

/** Wartość na liście różni się od rejestru o więcej niż 1% i 500 zł. */
export function differsFromRegister(listAmount: number, regTotal: number): boolean {
  const d = Math.abs(listAmount - regTotal);
  return d > 500 && d > 0.01 * Math.max(listAmount, regTotal);
}
