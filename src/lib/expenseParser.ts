// ============================================================
// expenseParser.ts — HBM TruckCalc
// Parses "Kartoteka Wydatków" XLS (client-side, XLSX.js)
// Groups costs per vehicle / month / category in EUR
// ============================================================

import * as XLSX from "xlsx";

// ── Category mapping (from Kartoteka "rodzaj" column) ────────
export type ExpenseCategory =
  | "fuel"        // ON
  | "toll"        // Autostrady
  | "leasing"     // Leasing
  | "insurance"   // Ubezpieczenie
  | "adblue"      // AdBlue
  | "parts"       // Części
  | "service"     // Koszt usług / Koszt usług serwis
  | "tires"       // Ogumienie
  | "tax"         // Podatek od środków transportu
  | "other";      // Inne / uncategorized

const CATEGORY_MAP: Record<string, ExpenseCategory> = {
  "on":                   "fuel",
  "diesel":               "fuel",
  "paliwo":               "fuel",
  "autostrady":           "toll",
  "myto":                 "toll",
  "parkingi":             "toll",     // parking + toll lumped together
  "leasing":              "leasing",
  "ubezpieczenie":        "insurance",
  "oc":                   "insurance",
  "ac":                   "insurance",
  "adblue":               "adblue",
  "ad blue":              "adblue",
  "części":               "parts",
  "czesci":               "parts",
  "koszt usług serwis":   "service",  // more specific first
  "koszt usług":          "service",
  "koszt uslug":          "service",
  "serwis":               "service",
  "ogumienie":            "tires",
  "opony":                "tires",
  "podatek od środków":   "tax",
  "podatek":              "tax",
  "inne":                 "other",
};

function mapCategory(raw: string): ExpenseCategory {
  if (!raw) return "other";
  const lower = raw.toLowerCase().trim();
  for (const [key, cat] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key)) return cat;
  }
  return "other";
}

// ── Column indices in Kartoteka XLS ──────────────────────────
const COL = {
  vehicleReg:   2,   // nr_rejestracyjny
  dateSerial:   3,   // data_wydatku (Excel serial)
  name:         4,   // nazwa wydatku
  category:     5,   // rodzaj (category label)
  qty:          6,   // ilość
  netPln:       7,   // netto (PLN or EUR depending on waluta)
  currency:     8,   // waluta ("EUR" | "PLN")
  euroVal:      17,  // euro — value already in EUR (may be 0 or missing)
  exchangeRate: 18,  // kurs NBP: PLN/EUR (~4.25) for EUR rows; PLN/100HUF (~1.19) for HUF; PLN/unit for CZK/RON/SEK; 1.0 for PLN
  seller:       12,  // sprzedawca
} as const;

// ── Dostawcy wykluczeni z kosztów floty ────────────────────────
// Koszty nieflotowe (np. roboty budowlane) księgowane w tej samej
// Kartotece Wydatków bez przypisanego pojazdu trafiały do puli "INNE"
// i były proporcjonalnie rozdzielane na wszystkie pojazdy floty.
// Dopasowanie: wszystkie fragmenty (case-insensitive) muszą wystąpić
// w kolumnie "Sprzedawca".
const EXCLUDED_SELLERS: string[][] = [
  ["hurst", "banaszkiewicz"],
];

function isExcludedSeller(sellerRaw: string): boolean {
  const s = sellerRaw.toLowerCase();
  return EXCLUDED_SELLERS.some(parts => parts.every(p => s.includes(p)));
}

// ── Date helpers ──────────────────────────────────────────────
/** Excel serial → "YYYY-MM" */
function serialToYearMonth(serial: number): string {
  const date = new Date((serial - 25569) * 86400 * 1000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Any date cell → "YYYY-MM" or "" */
function toYearMonth(raw: unknown): string {
  if (raw == null || raw === "") return "";
  // Excel serial number
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!isNaN(n) && n > 40000) return serialToYearMonth(n);
  // String format "DD-MM-YYYY ..." or "YYYY-MM-..."
  const s = String(raw);
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}`;
  const iso = s.match(/^(\d{4})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  return "";
}

// ── Per-entry result ──────────────────────────────────────────
export interface ExpenseEntry {
  vehicleReg: string;
  yearMonth:  string;   // "YYYY-MM"
  category:   ExpenseCategory;
  categoryRaw: string;
  nameRaw:    string;
  amountEur:  number;
}

// ── Aggregate: vehicle → month → category → total EUR ────────
export type ExpenseMap = Map<
  string,                         // vehicleReg
  Map<
    string,                       // "YYYY-MM"
    Record<ExpenseCategory, number>
  >
>;

function emptyCategories(): Record<ExpenseCategory, number> {
  return {
    fuel: 0, toll: 0, leasing: 0, insurance: 0,
    adblue: 0, parts: 0, service: 0, tires: 0, tax: 0, other: 0,
  };
}

/** Normalize vehicle reg: uppercase, trim, remove spaces/dashes for comparison */
export function normalizeReg(reg: string): string {
  return reg.toUpperCase().replace(/[\s\-]/g, "").trim();
}

// ── Main parse function ───────────────────────────────────────
export interface ParseExpenseResult {
  entries:    ExpenseEntry[];
  expenseMap: ExpenseMap;
  months:     string[];      // sorted unique "YYYY-MM"
  vehicles:   string[];      // sorted unique reg numbers
  totalEur:   number;
  warnings:   string[];
  inneRedistributedEur: number;  // total EUR redistributed from "INNE" entries
  excludedEur:   number;  // total EUR pominięte (wykluczeni dostawcy — koszty nieflotowe)
  excludedCount: number;  // liczba pominiętych wierszy
}

export function parseKartotekaXLS(
  file: ArrayBuffer,
  plnEurFallback = 4.25,
  distributeInne = true,   // jeśli true → koszty bez pojazdu dzielone proporcjonalnie
): ParseExpenseResult {
  const wb = XLSX.read(file, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  const entries: ExpenseEntry[] = [];
  const warnings: string[] = [];
  const expenseMap: ExpenseMap = new Map();
  let excludedEur = 0;
  let excludedCount = 0;

  // Find header row — look for "nr_rejestracyjny" or "rejestracyjny"
  let dataStartRow = 1;
  for (let i = 0; i < Math.min(5, raw.length); i++) {
    const rowStr = raw[i].map(c => String(c).toLowerCase()).join(" ");
    if (rowStr.includes("rejestracyjny") || rowStr.includes("rodzaj") || rowStr.includes("wydatek")) {
      dataStartRow = i + 1;
      break;
    }
  }

  for (let ri = dataStartRow; ri < raw.length; ri++) {
    const row = raw[ri];
    if (!row || row.length < 8) continue;

    const regRaw = String(row[COL.vehicleReg] ?? "").trim();
    // Brak przypisanego pojazdu → grupuj jako "INNE" (koszty ogólne)
    const resolvedReg = (!regRaw || regRaw.toLowerCase() === "brak") ? "INNE" : regRaw;

    const dateRaw = row[COL.dateSerial];
    const yearMonth = toYearMonth(dateRaw);
    if (!yearMonth) {
      warnings.push(`Wiersz ${ri + 1}: brak daty — pominięto`);
      continue;
    }

    const categoryRaw = String(row[COL.category] ?? "").trim();
    const nameRaw     = String(row[COL.name]     ?? "").trim();
    const category    = mapCategory(categoryRaw || nameRaw);

    const currency = String(row[COL.currency] ?? "").toUpperCase().trim();
    const netRaw   = parseFloat(String(row[COL.netPln] ?? "0").replace(",", ".")) || 0;
    const euroRaw  = parseFloat(String(row[COL.euroVal] ?? "0").replace(",", ".")) || 0;
    // Kartoteka stores exchange rate only for EUR invoices (~4.2x).
    // For PLN entries kurs = 1.0 (not a real rate) — must use fallback.
    const kurs     = parseFloat(String(row[COL.exchangeRate] ?? "0").replace(",", ".")) || 0;

    let amountEur: number;
    if (euroRaw > 0) {
      // Column 17 "Euro" pre-calculated EUR value — use directly
      amountEur = euroRaw;
    } else if (currency === "EUR") {
      amountEur = netRaw;
    } else if (currency === "HUF") {
      // NBP quotes HUF as PLN per 100 HUF (e.g. kurs=1.1937 → 1.1937 PLN/100 HUF)
      // Use kurs from file if available, otherwise fallback to ~0.012 PLN/HUF
      const plnPerHuf = kurs > 0 ? kurs / 100 : 0.012;
      const plnAmount = netRaw * plnPerHuf;
      amountEur = plnAmount / plnEurFallback;
    } else if (currency === "PLN") {
      // PLN → EUR: kurs = 1.0 dla wpisów PLN (nie jest realnym kursem), zawsze fallback
      amountEur = netRaw / plnEurFallback;
    } else {
      // CZK, RON, SEK i inne waluty obce:
      // kurs = PLN za 1 jednostkę waluty (np. 0.1752 PLN/CZK, 0.81 PLN/RON)
      // netto jest w walucie obcej → netto * kurs = PLN → / plnEurFallback = EUR
      if (kurs > 0) {
        amountEur = (netRaw * kurs) / plnEurFallback;
      } else {
        warnings.push(`Wiersz ${ri + 1}: ${currency} bez kursu NBP — pominięto`);
        amountEur = 0;
      }
    }

    if (amountEur <= 0) continue;

    // Dostawca nieflotowy (np. roboty budowlane) — pomiń całkowicie,
    // żeby nie trafiał do puli "INNE" i nie był rozdzielany na pojazdy
    const sellerRaw = String(row[COL.seller] ?? "").trim();
    if (isExcludedSeller(sellerRaw)) {
      excludedEur = Math.round((excludedEur + amountEur) * 100) / 100;
      excludedCount++;
      continue;
    }

    const vehicleReg = resolvedReg === "INNE" ? "INNE" : normalizeReg(resolvedReg);
    const entry: ExpenseEntry = {
      vehicleReg,
      yearMonth,
      category,
      categoryRaw,
      nameRaw,
      amountEur: Math.round(amountEur * 100) / 100,
    };
    entries.push(entry);

    // Build aggregate map
    if (!expenseMap.has(vehicleReg)) expenseMap.set(vehicleReg, new Map());
    const vMap = expenseMap.get(vehicleReg)!;
    if (!vMap.has(yearMonth)) vMap.set(yearMonth, emptyCategories());
    const cats = vMap.get(yearMonth)!;
    cats[category] = Math.round((cats[category] + amountEur) * 100) / 100;
  }

  // ── Proporcjonalny podział kosztów "INNE" (bez pojazdu) ──────
  let inneRedistributedEur = 0;

  if (distributeInne && expenseMap.has("INNE")) {
    const inneMap = expenseMap.get("INNE")!;

    for (const [yearMonth, inneCats] of inneMap) {
      // Suma kosztów INNE w tym miesiącu
      const inneMonthTotal = Object.values(inneCats).reduce((s, v) => s + v, 0);
      if (inneMonthTotal <= 0) continue;

      // Suma kosztów na pojazd w tym samym miesiącu (bez INNE)
      const vehicleTotals = new Map<string, number>();
      for (const [vreg, vMap] of expenseMap) {
        if (vreg === "INNE") continue;
        const cats = vMap.get(yearMonth);
        if (!cats) continue;
        const total = Object.values(cats).reduce((s, v) => s + v, 0);
        if (total > 0) vehicleTotals.set(vreg, total);
      }

      if (vehicleTotals.size === 0) {
        // Brak pojazdów w tym miesiącu — koszty ogólne zostają jako INNE
        warnings.push(`${yearMonth}: INNE (${inneMonthTotal.toFixed(2)} EUR) — brak pojazdów do podziału`);
        continue;
      }

      const fleetTotal = Array.from(vehicleTotals.values()).reduce((s, v) => s + v, 0);

      // Rozdziel każdą kategorię proporcjonalnie
      for (const [vreg, vTotal] of vehicleTotals) {
        const share = vTotal / fleetTotal;
        if (!expenseMap.has(vreg)) expenseMap.set(vreg, new Map());
        const vMap = expenseMap.get(vreg)!;
        if (!vMap.has(yearMonth)) vMap.set(yearMonth, emptyCategories());
        const cats = vMap.get(yearMonth)!;

        for (const cat of Object.keys(inneCats) as ExpenseCategory[]) {
          const portion = inneCats[cat] * share;
          if (portion > 0) {
            cats[cat] = Math.round((cats[cat] + portion) * 100) / 100;
          }
        }
      }

      inneRedistributedEur = Math.round((inneRedistributedEur + inneMonthTotal) * 100) / 100;
    }

    // Usuń INNE z mapy — koszty rozdzielone
    expenseMap.delete("INNE");
    warnings.push(`Koszty bez pojazdu: ${inneRedistributedEur.toFixed(2)} EUR podzielone proporcjonalnie`);
  }

  // Collect sorted unique months and vehicles
  const monthSet = new Set<string>();
  const vehicleSet = new Set<string>();
  for (const entry of entries) {
    monthSet.add(entry.yearMonth);
    // Pomiń INNE w liście pojazdów gdy redystrybucja włączona
    if (distributeInne && entry.vehicleReg === "INNE") continue;
    vehicleSet.add(entry.vehicleReg);
  }
  // Dodaj pojazdy z mapy (po redystrybucji mogły pojawić się nowe miesiące)
  for (const vreg of expenseMap.keys()) {
    vehicleSet.add(vreg);
  }
  const months   = Array.from(monthSet).sort();
  const vehicles = Array.from(vehicleSet).sort();
  const totalEur = Math.round(entries.reduce((s, e) => s + e.amountEur, 0) * 100) / 100;

  if (excludedCount > 0) {
    warnings.push(`Wykluczono ${excludedCount} wierszy dostawców nieflotowych: ${excludedEur.toFixed(2)} EUR`);
  }

  return { entries, expenseMap, months, vehicles, totalEur, warnings, inneRedistributedEur, excludedEur, excludedCount };
}

// ── Helper: get total cost for vehicle/month ──────────────────
export function getMonthTotal(
  expenseMap: ExpenseMap,
  vehicleReg: string,
  yearMonth: string,
): number {
  const vMap = expenseMap.get(normalizeReg(vehicleReg));
  if (!vMap) return 0;
  const cats = vMap.get(yearMonth);
  if (!cats) return 0;
  return Object.values(cats).reduce((s, v) => s + v, 0);
}

/** Get total for a specific category, all months */
export function getCategoryTotal(
  expenseMap: ExpenseMap,
  vehicleReg: string,
  category: ExpenseCategory,
): number {
  const vMap = expenseMap.get(normalizeReg(vehicleReg));
  if (!vMap) return 0;
  let total = 0;
  for (const cats of vMap.values()) total += cats[category] ?? 0;
  return Math.round(total * 100) / 100;
}

/** Returns months with any costs for a vehicle */
export function getActiveMonths(expenseMap: ExpenseMap, vehicleReg: string): string[] {
  const vMap = expenseMap.get(normalizeReg(vehicleReg));
  if (!vMap) return [];
  return Array.from(vMap.keys()).filter(m => {
    const cats = vMap.get(m)!;
    return Object.values(cats).some(v => v > 0);
  }).sort();
}
