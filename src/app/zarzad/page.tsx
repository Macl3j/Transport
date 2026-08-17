"use client";

import { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import { parseKartotekaXLS, type ExpenseEntry } from "@/lib/expenseParser";
import { parseDriversODS, type DriversSummary } from "@/lib/odsParser";

// ── Types ─────────────────────────────────────────────────────

interface TmsRoute {
  vehicle: string;
  frachtEur: number;
  distanceKm: number;
  totalCostEur: number;
}

interface AdminCostRow {
  category: string;
  amountPln: number;
  amountEur: number;
}

interface MonthData {
  label: string;       // "YYYY-MM" or user label
  // TMS
  tmsLoaded: boolean;
  tmsFileName: string;
  tmsRevenue: number;  // EUR
  tmsRoutes: TmsRoute[];
  tmsBuf: ArrayBuffer | null;          // stored for re-parse on month change
  tmsAvailableMonths: string[];        // all months detected in the file
  // Kartoteka
  kartotekaLoaded: boolean;
  kartotekaFileName: string;
  kartotekaTotal: number;    // EUR
  kartotekaEntries: ExpenseEntry[];
  kartotekaExcludedEur: number;    // wykluczeni dostawcy nieflotowi
  kartotekaExcludedCount: number;
  // ODS Kierowcy
  odsLoaded: boolean;
  odsFileName: string;
  drivers: DriversSummary | null;
  driversCostEur: number;    // total / kurs
  plnEurRate: number;        // PLN/EUR rate used for conversion
  // Administracja
  adminLoaded: boolean;
  adminFileName: string;
  adminTotal: number;    // EUR
  adminRows: AdminCostRow[];
}

function emptyMonth(label: string): MonthData {
  return {
    label,
    tmsLoaded: false, tmsFileName: "", tmsRevenue: 0, tmsRoutes: [],
    tmsBuf: null, tmsAvailableMonths: [],
    kartotekaLoaded: false, kartotekaFileName: "", kartotekaTotal: 0, kartotekaEntries: [],
    kartotekaExcludedEur: 0, kartotekaExcludedCount: 0,
    odsLoaded: false, odsFileName: "", drivers: null, driversCostEur: 0, plnEurRate: 4.25,
    adminLoaded: false, adminFileName: "", adminTotal: 0, adminRows: [],
  };
}

// ── TMS Parser (simplified — revenue extraction) ───────────────

/** Extract numeric EUR/PLN amount from a cell (string or number) */
function parseCurrencyCell(val: unknown): number {
  if (typeof val === "number") return val;
  const raw = String(val ?? "").replace(/\s/g, ""); // strip spaces incl. nbsp
  if (!raw) return 0;
  // Patterns: "1234,56EUR" | "1234.56EUR" | "1234,56euro" | "€1234,56" | plain "1234,56"
  // First try: digits with optional comma/period separator, optionally followed by eur/euro/€
  const m = raw.match(/^[€$]?([\d]+(?:[.,][\d]+)?)/);
  if (m) {
    // Normalize: European comma → period
    return parseFloat(m[1].replace(",", ".")) || 0;
  }
  return 0;
}

function parseTmsRevenue(
  buffer: ArrayBuffer,
  filterMonth?: string   // "YYYY-MM" — jeśli podany, filtruje tylko ten miesiąc
): { revenue: number; routes: TmsRoute[]; label: string; availableMonths: string[] } {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });

  const routes: TmsRoute[] = [];
  let revenue = 0;
  let label = "";

  // Detect header row and column indices
  let frachtCol = -1, vehicleCol = -1, distCol = -1, dateCol = -1;
  let headerRow = -1;

  // Priority keywords for fracht column (most specific first)
  // "Fracht z walutą *" is the standard Rejestr Transportów column name
  const FRACHT_KEYS = ["fracht eur netto", "fracht z walutą", "kwota frachtu", "fracht eur", "wartość frachtu",
                       "fracht netto", "stawka fracht", "kwota eur", "kwota euro", "przychód", "fracht"];

  // Header row detection: must contain column-level keywords, NOT just title-row words like "zleceniodawca"
  // A valid header row has "fracht" from "Fracht z walutą *", or "ciągnik", or "nr pełny", etc.
  // We avoid matching "zleceni" alone (matches "Dane zlecenia" title rows).
  const isHeaderRow = (row: unknown[]) => {
    const joined = row.map((v) => String(v ?? "").toLowerCase()).join("|");
    return (
      joined.includes("fracht eur netto") ||
      joined.includes("fracht z walutą") ||
      joined.includes("fracht eur") ||
      joined.includes("kwota frachtu") ||
      joined.includes("ciągnik") ||
      joined.includes("ciagnik") ||
      joined.includes("nr pełny") ||
      joined.includes("nr zlecenia") ||
      joined.includes("stawka końcow") ||
      (joined.includes("fracht") && (joined.includes("ciągnik") || joined.includes("pojazd") || joined.includes("data utw"))) ||
      (joined.includes("stawka") && (joined.includes("euro") || joined.includes("eur")) && joined.includes("km"))
    );
  };

  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r] as unknown[];
    if (!isHeaderRow(row)) continue;
    headerRow = r;
    // Pass 1: specific fracht keys
    for (const key of FRACHT_KEYS) {
      if (frachtCol !== -1) break;
      row.forEach((v, i) => {
        if (frachtCol !== -1) return;
        if (String(v ?? "").toLowerCase().includes(key)) frachtCol = i;
      });
    }
    // Pass 2: fallback — any "stawka" col that also mentions EUR/euro
    if (frachtCol === -1) {
      row.forEach((v, i) => {
        if (frachtCol !== -1) return;
        const s = String(v ?? "").toLowerCase();
        if (s.includes("stawka") && (s.includes("eur") || s.includes("euro"))) frachtCol = i;
      });
    }
    // Pass 3: last resort — "stawka" not related to driver/day
    if (frachtCol === -1) {
      row.forEach((v, i) => {
        if (frachtCol !== -1) return;
        const s = String(v ?? "").toLowerCase();
        if (s.includes("stawka") && !s.includes("kierow") && !s.includes("dzien") && !s.includes("dniów")) frachtCol = i;
      });
    }
    row.forEach((v, i) => {
      const s = String(v ?? "").toLowerCase();
      if ((s.includes("pojazd") || s.includes("nr rej") || s.includes("ciągnik") || s.includes("ciagnik")) && vehicleCol === -1) vehicleCol = i;
      // Prefer "km ład" (loaded km); avoid picking "puste" (empty run km)
      if (distCol === -1 && (s.includes("km ład") || s === "km" || s.includes("km wg"))) distCol = i;
    });
    // Date priority: 1) "Dostarczenie rzeczywiste" (actual delivery), 2) "Dostarczenie" (planned delivery),
    // 3) other date columns, 4) any "data" fallback
    const datePriority = [
      (s: string) => s === "dostarczenie rzeczywiste" || (s.includes("dostarcz") && s.includes("rzeczyw")),
      (s: string) => s === "dostarczenie",
      (s: string) => s.includes("data utw") || s.includes("data zał") || s.includes("data wyjazd") || s.includes("data załadun"),
      (s: string) => s.includes("data"),
    ];
    for (const test of datePriority) {
      if (dateCol !== -1) break;
      row.forEach((v, i) => {
        if (dateCol !== -1) return;
        if (test(String(v ?? "").toLowerCase())) dateCol = i;
      });
    }
    break;
  }

  if (headerRow === -1) {
    // Fallback: assume first non-empty row with most columns as header
    headerRow = 0;
    const row = rows[0] as unknown[];
    for (const key of FRACHT_KEYS) {
      if (frachtCol !== -1) break;
      row.forEach((v, i) => {
        if (frachtCol !== -1) return;
        if (String(v ?? "").toLowerCase().includes(key)) frachtCol = i;
      });
    }
    row.forEach((v, i) => {
      const s = String(v ?? "").toLowerCase();
      if ((s.includes("pojazd") || s.includes("nr rej") || s.includes("ciągnik")) && vehicleCol === -1) vehicleCol = i;
      if (s.includes("km ład") && distCol === -1) distCol = i;
      if (s.includes("data") && dateCol === -1) dateCol = i;
    });
  }

  // Debug: log what was detected + first rows for format diagnosis
  const headerRowData = rows[headerRow] as unknown[] | undefined;
  console.log(
    "[TMS parser] headerRow:", headerRow,
    "frachtCol:", frachtCol, "→", frachtCol >= 0 ? String(headerRowData?.[frachtCol] ?? "?") : "nie znaleziono",
    "dateCol:", dateCol, "→", dateCol >= 0 ? String(headerRowData?.[dateCol] ?? "?") : "nie znaleziono",
    "vehicleCol:", vehicleCol, "→", vehicleCol >= 0 ? String(headerRowData?.[vehicleCol] ?? "?") : "nie znaleziono",
    "filterMonth:", filterMonth ?? "(brak)",
  );
  // Print first 3 rows to help diagnose column structure
  for (let dbgR = 0; dbgR < Math.min(3, rows.length); dbgR++) {
    const dbgRow = rows[dbgR] as unknown[];
    console.log(`[TMS parser] row[${dbgR}]:`, dbgRow.slice(0, 20).map((v, i) => `[${i}]=${String(v ?? "").substring(0, 30)}`).join("  "));
  }

  // Try to detect label from date column values
  const months = new Set<string>();
  let lastSeenMonth = "";
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] as unknown[];
    if (!row || row.every((v) => v == null || v === "")) continue;

    // Ignore summary rows to prevent double-counting
    const isSummary = row.some(v => {
      const str = String(v ?? "").toLowerCase().trim();
      return str.includes("podsumowanie") || str === "razem" || str === "suma" || str === "ogółem" || str.startsWith("razem:") || str.startsWith("suma:");
    });
    if (isSummary) continue;

    // Parse fracht
    let fracht = 0;
    if (frachtCol >= 0) {
      fracht = parseCurrencyCell(row[frachtCol]);
    }

    const vehicle =
      vehicleCol >= 0 ? String(row[vehicleCol] ?? "").trim() : "";

    const dist =
      distCol >= 0
        ? parseFloat(String(row[distCol] ?? "0").replace(",", ".")) || 0
        : 0;

    // Date for label detection + month filter
    let rowMonth = "";
    if (dateCol >= 0 && row[dateCol]) {
      const ds = String(row[dateCol]).trim();
      const n = parseFloat(ds);
      // Ensure it's not parsing purely a year like "2026-06" as n=2026
      if (!isNaN(n) && n > 40000 && String(n) === ds) {
        const d = new Date((n - 25569) * 86400 * 1000);
        rowMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      } else {
        const m = ds.match(/(\d{4})[.\-/](\d{2})/);
        if (m) {
          rowMonth = `${m[1]}-${m[2]}`;
        } else {
          const m2 = ds.match(/(\d{2})[.\-/](\d{2})[.\-/](\d{4})/);
          if (m2) {
            rowMonth = `${m2[3]}-${m2[2]}`;
          } else {
            const m3 = ds.match(/(\d{2})[.\-/](\d{4})/);
            if (m3) rowMonth = `${m3[2]}-${m3[1]}`;
          }
        }
      }
      if (rowMonth) {
        months.add(rowMonth);
        lastSeenMonth = rowMonth;
      }
    }

    const effectiveMonth = rowMonth || lastSeenMonth;

    // Skip if filter active and row doesn't match
    if (filterMonth && effectiveMonth && effectiveMonth !== filterMonth) continue;

    if (fracht > 0) {
      revenue += fracht;
      routes.push({ vehicle, frachtEur: fracht, distanceKm: dist, totalCostEur: 0 });
    }
  }

  const availableMonths = Array.from(months).sort();
  // label: use filterMonth if filtering, otherwise first detected month
  label = filterMonth ?? (availableMonths[0] ?? "");

  return { revenue, routes, label, availableMonths };
}

// ── Admin XLSX Parser ─────────────────────────────────────────

function parseAdminXlsx(
  buffer: ArrayBuffer,
  plnEurRate: number
): { total: number; rows: AdminCostRow[]; month: string } {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });

  const rows: AdminCostRow[] = [];
  let totalEur = 0;
  let month = "";
  let rate = plnEurRate;

  for (let r = 0; r < raw.length; r++) {
    const row = raw[r] as unknown[];
    if (!row) continue;

    // Look for month info
    const joined = row.map((v) => String(v ?? "").toLowerCase()).join(" ");
    if (joined.includes("miesi") && !month) {
      for (let c = 0; c < row.length; c++) {
        const s = String(row[c] ?? "");
        if (/^\d{4}-\d{2}$/.test(s.trim())) {
          month = s.trim(); break;
        }
      }
    }
    // Look for exchange rate
    if ((joined.includes("kurs") || joined.includes("eur")) && rate === plnEurRate) {
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (typeof v === "number" && v > 3 && v < 6) {
          rate = v; break;
        }
      }
    }

    // Data rows: col 1 = category text, col 3 = amount PLN
    const cat = String(row[1] ?? "").trim();
    const amtRaw = row[3];
    if (!cat || cat.toLowerCase().includes("kategori") || cat.toLowerCase() === "lp") continue;
    if (cat.toLowerCase().includes("razem") || cat.toLowerCase().includes("suma")) {
      // This is a total row — skip for accumulation
      continue;
    }

    const amtPln =
      typeof amtRaw === "number"
        ? amtRaw
        : parseFloat(String(amtRaw ?? "0").replace(",", ".")) || 0;

    if (amtPln > 0) {
      const amtEur = Math.round((amtPln / rate) * 100) / 100;
      rows.push({ category: cat, amountPln: amtPln, amountEur: amtEur });
      totalEur += amtEur;
    }
  }

  return { total: Math.round(totalEur * 100) / 100, rows, month };
}

// ── Formatting helpers ────────────────────────────────────────

const fmtEur = (v: number) =>
  v.toLocaleString("pl-PL", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }) + " €";

const fmtPln = (v: number) =>
  v.toLocaleString("pl-PL", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }) + " PLN";

const fmtPct = (v: number, base: number) =>
  base > 0 ? (((v / base) * 100).toFixed(1) + "%") : "—";

function marginColor(pct: number): string {
  if (pct >= 15) return "text-emerald-600 font-semibold";
  if (pct >= 8) return "text-yellow-600 font-semibold";
  if (pct >= 0) return "text-orange-600 font-semibold";
  return "text-red-600 font-semibold";
}

function marginBg(pct: number): string {
  if (pct >= 15) return "bg-emerald-50 border-l-4 border-emerald-500";
  if (pct >= 8) return "bg-yellow-50 border-l-4 border-yellow-400";
  if (pct >= 0) return "bg-orange-50 border-l-4 border-orange-400";
  return "bg-red-50 border-l-4 border-red-500";
}

// ── Upload Button ─────────────────────────────────────────────

function UploadBtn({
  label,
  accept,
  loaded,
  fileName,
  onFile,
  loading,
}: {
  label: string;
  accept: string;
  loaded: boolean;
  fileName: string;
  onFile: (buf: ArrayBuffer, name: string) => void;
  loading?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        {label}
      </span>
      <button
        onClick={() => ref.current?.click()}
        disabled={loading}
        className={`relative flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-all
          ${
            loaded
              ? "bg-emerald-50 border-emerald-300 text-emerald-700"
              : "bg-white border-dashed border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50"
          }`}
      >
        <span className="text-base">{loaded ? "✅" : "📂"}</span>
        <span className="truncate max-w-[180px]">
          {loaded ? fileName : "Wybierz plik…"}
        </span>
        {loading && (
          <span className="ml-auto text-blue-500 animate-pulse">⏳</span>
        )}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const r = new FileReader();
          r.onload = (ev) => {
            if (ev.target?.result instanceof ArrayBuffer)
              onFile(ev.target.result, f.name);
          };
          r.readAsArrayBuffer(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────

const NUM_MONTHS = 3;

export default function ZarzadPage() {
  const [months, setMonths] = useState<MonthData[]>([
    emptyMonth("Miesiąc 1"),
    emptyMonth("Miesiąc 2"),
    emptyMonth("Miesiąc 3"),
  ]);
  const [activeTab, setActiveTab] = useState(0);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [showDrivers, setShowDrivers] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showUpload, setShowUpload] = useState(true);

  const setLoad = (key: string, v: boolean) =>
    setLoading((p) => ({ ...p, [key]: v }));

  const updateMonth = useCallback(
    (idx: number, patch: Partial<MonthData>) =>
      setMonths((prev) =>
        prev.map((m, i) => (i === idx ? { ...m, ...patch } : m))
      ),
    []
  );

  // ── File handlers ──────────────────────────────────────────

  const handleTms = (idx: number, buf: ArrayBuffer, name: string) => {
    setLoad(`tms${idx}`, true);
    setTimeout(() => {
      try {
        // If user set a YYYY-MM label before upload, use it as month filter
        const existingLabel = months[idx].label;
        const isMonthLabel = /^\d{4}-\d{2}$/.test(existingLabel);
        const filterMonth = isMonthLabel ? existingLabel : undefined;
        const { revenue, routes, label, availableMonths } = parseTmsRevenue(buf, filterMonth);
        updateMonth(idx, {
          tmsLoaded: true,
          tmsFileName: name,
          tmsRevenue: Math.round(revenue * 100) / 100,
          tmsRoutes: routes,
          tmsBuf: buf,
          tmsAvailableMonths: availableMonths,
          label: months[idx].label.startsWith("Miesiąc") && label
            ? label
            : months[idx].label,
        });
      } catch {
        alert("Błąd parsowania pliku TMS. Sprawdź format.");
      } finally {
        setLoad(`tms${idx}`, false);
      }
    }, 10);
  };

  // Re-parse TMS with a different month (without re-uploading)
  const handleTmsMonthChange = (idx: number, newMonth: string) => {
    const m = months[idx];
    if (!m.tmsBuf) return;
    setLoad(`tms${idx}`, true);
    setTimeout(() => {
      try {
        const { revenue, routes, label, availableMonths } = parseTmsRevenue(m.tmsBuf!, newMonth);
        updateMonth(idx, {
          tmsRevenue: Math.round(revenue * 100) / 100,
          tmsRoutes: routes,
          tmsAvailableMonths: availableMonths,
          label,
        });
      } catch {
        alert("Błąd re-parsowania TMS.");
      } finally {
        setLoad(`tms${idx}`, false);
      }
    }, 10);
  };

  const handleKartoteka = (idx: number, buf: ArrayBuffer, name: string) => {
    setLoad(`kart${idx}`, true);
    setTimeout(() => {
      try {
        const result = parseKartotekaXLS(buf, months[idx].plnEurRate || 4.25);
        // Filter entries to matching month if label is set
        const existingLabelK = months[idx].label;
        const isMonthLabelK = /^\d{4}-\d{2}$/.test(existingLabelK);
        const filteredEntries = isMonthLabelK
          ? result.entries.filter((e) => e.yearMonth === existingLabelK)
          : result.entries;
        const total = filteredEntries.reduce((s, e) => s + e.amountEur, 0);
        updateMonth(idx, {
          kartotekaLoaded: true,
          kartotekaFileName: name,
          kartotekaTotal: Math.round(total * 100) / 100,
          kartotekaEntries: filteredEntries,
          kartotekaExcludedEur: result.excludedEur,
          kartotekaExcludedCount: result.excludedCount,
          label: months[idx].label.startsWith("Miesiąc") && result.months[0]
            ? result.months[0]
            : months[idx].label,
        });
      } catch {
        alert("Błąd parsowania Kartoteki Wydatków.");
      } finally {
        setLoad(`kart${idx}`, false);
      }
    }, 10);
  };

  const handleOds = (idx: number, buf: ArrayBuffer, name: string) => {
    setLoad(`ods${idx}`, true);
    setTimeout(() => {
      try {
        const m = months[idx];
        const rate = m.plnEurRate || 4.25;
        const summary = parseDriversODS(buf, m.label.match(/^\d{4}-\d{2}$/) ? m.label : undefined);
        const costEur = Math.round((summary.totalPayout / rate) * 100) / 100;
        updateMonth(idx, {
          odsLoaded: true,
          odsFileName: name,
          drivers: summary,
          driversCostEur: costEur,
        });
      } catch {
        alert("Błąd parsowania pliku ODS wypłat kierowców.");
      } finally {
        setLoad(`ods${idx}`, false);
      }
    }, 10);
  };

  const handleAdmin = (idx: number, buf: ArrayBuffer, name: string) => {
    setLoad(`adm${idx}`, true);
    setTimeout(() => {
      try {
        const rate = months[idx].plnEurRate || 4.25;
        const { total, rows, month } = parseAdminXlsx(buf, rate);
        updateMonth(idx, {
          adminLoaded: true,
          adminFileName: name,
          adminTotal: total,
          adminRows: rows,
          label: months[idx].label.startsWith("Miesiąc") && month
            ? month
            : months[idx].label,
        });
      } catch {
        alert("Błąd parsowania pliku Administracja XLSX.");
      } finally {
        setLoad(`adm${idx}`, false);
      }
    }, 10);
  };

  // ── P&L calculation ────────────────────────────────────────

  function calcPnl(m: MonthData) {
    const revenue = m.tmsRevenue;
    const vehicleCosts = m.kartotekaTotal;
    const driverCosts = m.driversCostEur;
    const adminCosts = m.adminTotal;

    const marzaI = revenue - vehicleCosts;
    const marzaII = marzaI - driverCosts;
    const ebit = marzaII - adminCosts;

    return {
      revenue,
      vehicleCosts,
      driverCosts,
      adminCosts,
      marzaI,
      marzaII,
      ebit,
      marzaIPct: revenue > 0 ? (marzaI / revenue) * 100 : 0,
      marzaIIPct: revenue > 0 ? (marzaII / revenue) * 100 : 0,
      ebitPct: revenue > 0 ? (ebit / revenue) * 100 : 0,
      hasData: m.tmsLoaded || m.kartotekaLoaded || m.odsLoaded || m.adminLoaded,
    };
  }

  const pnls = months.map(calcPnl);
  const anyData = pnls.some((p) => p.hasData);

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            📊 Dashboard Zarządu — Controlling P&L
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            3-poziomowy rachunek wyników · maks. 3 miesiące porównawcze
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href="/session/clever-focused-ritchie/mnt/TRANSPORT/administracja_szablon.xlsx"
            className="hidden"
          />
          <button
            onClick={() => setShowUpload((v) => !v)}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
          >
            {showUpload ? "▲ Ukryj upload" : "▼ Pokaż upload"}
          </button>
        </div>
      </div>

      {/* Upload Panels */}
      {showUpload && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {months.map((m, idx) => (
            <div
              key={idx}
              className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-4"
            >
              {/* Month label */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                  M{idx + 1}
                </span>
                <input
                  value={m.label}
                  onChange={(e) => updateMonth(idx, { label: e.target.value })}
                  className="flex-1 text-sm font-semibold text-slate-700 border-0 border-b border-dashed border-slate-300 focus:outline-none focus:border-blue-400 bg-transparent"
                  placeholder="YYYY-MM lub nazwa…"
                />
              </div>

              {/* PLN/EUR rate */}
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>Kurs PLN/EUR:</span>
                <input
                  type="number"
                  value={m.plnEurRate}
                  step={0.01}
                  min={3}
                  max={6}
                  onChange={(e) =>
                    updateMonth(idx, { plnEurRate: parseFloat(e.target.value) || 4.25 })
                  }
                  className="w-16 border border-slate-200 rounded px-1.5 py-0.5 text-xs text-slate-700"
                />
              </div>

              {/* Upload slots */}
              <UploadBtn
                label="TMS (przychody)"
                accept=".xls,.xlsx"
                loaded={m.tmsLoaded}
                fileName={m.tmsFileName}
                onFile={(buf, name) => handleTms(idx, buf, name)}
                loading={loading[`tms${idx}`]}
              />
              <UploadBtn
                label="Kartoteka Wydatków"
                accept=".xls,.xlsx"
                loaded={m.kartotekaLoaded}
                fileName={m.kartotekaFileName}
                onFile={(buf, name) => handleKartoteka(idx, buf, name)}
                loading={loading[`kart${idx}`]}
              />
              <UploadBtn
                label="Wypłaty Kierowców (.ods)"
                accept=".ods,.xls,.xlsx"
                loaded={m.odsLoaded}
                fileName={m.odsFileName}
                onFile={(buf, name) => handleOds(idx, buf, name)}
                loading={loading[`ods${idx}`]}
              />
              <UploadBtn
                label="Administracja (.xlsx)"
                accept=".xlsx,.xls"
                loaded={m.adminLoaded}
                fileName={m.adminFileName}
                onFile={(buf, name) => handleAdmin(idx, buf, name)}
                loading={loading[`adm${idx}`]}
              />

              {/* Month picker — shown when file has multiple months */}
              {m.tmsLoaded && m.tmsAvailableMonths.length > 1 && (
                <div className="flex items-center gap-2 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <span className="text-amber-700 font-medium whitespace-nowrap">📅 Miesiąc:</span>
                  <select
                    value={m.label}
                    onChange={(e) => handleTmsMonthChange(idx, e.target.value)}
                    className="flex-1 text-xs border border-amber-300 rounded px-1.5 py-0.5 bg-white text-slate-700 font-semibold"
                  >
                    {m.tmsAvailableMonths.map((mo) => (
                      <option key={mo} value={mo}>{mo}</option>
                    ))}
                  </select>
                  <span className="text-amber-600 text-[10px]">plik zawiera {m.tmsAvailableMonths.length} mies.</span>
                </div>
              )}

              {/* Quick status */}
              {m.tmsLoaded && (
                <div className="text-xs text-slate-500 border-t pt-2 space-y-0.5">
                  <div>
                    💰 Przychód: <strong>{fmtEur(m.tmsRevenue)}</strong>
                  </div>
                  {m.kartotekaLoaded && (
                    <div>
                      🚛 Koszty pojazdu: <strong>{fmtEur(m.kartotekaTotal)}</strong>
                    </div>
                  )}
                  {m.kartotekaLoaded && m.kartotekaExcludedCount > 0 && (
                    <div className="text-amber-600">
                      ⚠ Wykluczono {m.kartotekaExcludedCount} wierszy nieflotowych ({fmtEur(m.kartotekaExcludedEur)})
                    </div>
                  )}
                  {m.odsLoaded && m.drivers && (
                    <div>
                      👤 Kierowcy ({m.drivers.driverCount}x):{" "}
                      <strong>
                        {fmtPln(m.drivers.totalPayout)} / {fmtEur(m.driversCostEur)}
                      </strong>
                    </div>
                  )}
                  {m.adminLoaded && (
                    <div>
                      🏢 Administracja: <strong>{fmtEur(m.adminTotal)}</strong>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* P&L Summary Table */}
      {anyData && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">
              📋 Rachunek Wyników (P&L)
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-4 py-3 font-medium text-slate-500 w-64">
                    Wskaźnik
                  </th>
                  {months.map((m, i) => (
                    <th
                      key={i}
                      className="text-right px-4 py-3 font-semibold text-slate-700"
                    >
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Revenue */}
                <tr className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-600">💰 Przychód</td>
                  {pnls.map((p, i) => (
                    <td key={i} className="text-right px-4 py-2.5 text-slate-800 font-medium">
                      {p.revenue > 0 ? fmtEur(p.revenue) : "—"}
                    </td>
                  ))}
                </tr>

                {/* Vehicle costs */}
                <tr className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-500 pl-8 text-xs">
                    — Koszty pojazdów (Kartoteka)
                  </td>
                  {pnls.map((p, i) => (
                    <td key={i} className="text-right px-4 py-2.5 text-slate-600 text-xs">
                      {months[i].kartotekaLoaded ? `(${fmtEur(p.vehicleCosts)})` : "—"}
                    </td>
                  ))}
                </tr>

                {/* Marża I */}
                <tr className="border-b-2 border-slate-200 bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-800">
                    MARŻA I
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      (po kosztach pojazdów)
                    </span>
                  </td>
                  {pnls.map((p, i) => (
                    <td
                      key={i}
                      className={`text-right px-4 py-3 text-sm ${
                        months[i].tmsLoaded && months[i].kartotekaLoaded
                          ? marginColor(p.marzaIPct)
                          : "text-slate-400"
                      }`}
                    >
                      {months[i].tmsLoaded && months[i].kartotekaLoaded ? (
                        <>
                          {fmtEur(p.marzaI)}{" "}
                          <span className="text-xs font-normal">
                            ({p.marzaIPct.toFixed(1)}%)
                          </span>
                        </>
                      ) : months[i].tmsLoaded ? (
                        <span className="text-xs text-slate-400">brak Kartoteki</span>
                      ) : (
                        "—"
                      )}
                    </td>
                  ))}
                </tr>

                {/* Driver costs */}
                <tr className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-500 pl-8 text-xs">
                    — Koszty kierowców
                  </td>
                  {pnls.map((p, i) => (
                    <td key={i} className="text-right px-4 py-2.5 text-slate-600 text-xs">
                      {months[i].odsLoaded
                        ? `(${fmtEur(p.driverCosts)})`
                        : "—"}
                    </td>
                  ))}
                </tr>

                {/* Marża II */}
                <tr className="border-b-2 border-slate-200 bg-slate-50">
                  <td className="px-4 py-3 font-bold text-slate-800">
                    MARŻA II
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      (po kosztach kierowców)
                    </span>
                  </td>
                  {pnls.map((p, i) => (
                    <td
                      key={i}
                      className={`text-right px-4 py-3 text-sm ${
                        months[i].tmsLoaded && months[i].kartotekaLoaded && months[i].odsLoaded
                          ? marginColor(p.marzaIIPct)
                          : "text-slate-400"
                      }`}
                    >
                      {months[i].tmsLoaded && months[i].kartotekaLoaded && months[i].odsLoaded ? (
                        <>
                          {fmtEur(p.marzaII)}{" "}
                          <span className="text-xs font-normal">
                            ({p.marzaIIPct.toFixed(1)}%)
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  ))}
                </tr>

                {/* Admin costs */}
                <tr className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-500 pl-8 text-xs">
                    — Koszty administracji
                  </td>
                  {pnls.map((p, i) => (
                    <td key={i} className="text-right px-4 py-2.5 text-slate-600 text-xs">
                      {months[i].adminLoaded
                        ? `(${fmtEur(p.adminCosts)})`
                        : "—"}
                    </td>
                  ))}
                </tr>

                {/* EBIT */}
                <tr className="bg-[#1F3864] text-white">
                  <td className="px-4 py-3.5 font-bold text-lg">
                    EBIT
                    <span className="ml-2 text-xs font-normal text-blue-200">
                      (wynik operacyjny)
                    </span>
                  </td>
                  {pnls.map((p, i) => (
                    <td
                      key={i}
                      className={`text-right px-4 py-3.5 text-lg font-bold ${
                        p.ebitPct >= 8
                          ? "text-emerald-300"
                          : p.ebitPct >= 0
                          ? "text-yellow-300"
                          : "text-red-300"
                      }`}
                    >
                      {months[i].tmsLoaded ? (
                        <>
                          {fmtEur(p.ebit)}{" "}
                          <span className="text-sm font-normal">
                            ({p.ebitPct.toFixed(1)}%)
                          </span>
                        </>
                      ) : (
                        <span className="text-blue-300 text-sm font-normal">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Trend indicator bar */}
      {anyData && pnls.filter((p) => p.revenue > 0).length >= 2 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider mb-4">
            📈 Trend EBIT %
          </h2>
          <div className="flex items-end gap-4 h-20">
            {pnls.map((p, i) =>
              p.revenue > 0 ? (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <span
                    className={`text-xs font-bold ${
                      p.ebitPct >= 8
                        ? "text-emerald-600"
                        : p.ebitPct >= 0
                        ? "text-yellow-600"
                        : "text-red-600"
                    }`}
                  >
                    {p.ebitPct.toFixed(1)}%
                  </span>
                  <div
                    className={`w-full rounded-t-md ${
                      p.ebitPct >= 8
                        ? "bg-emerald-400"
                        : p.ebitPct >= 0
                        ? "bg-yellow-400"
                        : "bg-red-400"
                    }`}
                    style={{
                      height: `${Math.max(4, Math.min(60, Math.abs(p.ebitPct) * 3))}px`,
                    }}
                  />
                  <span className="text-xs text-slate-500 truncate w-full text-center">
                    {months[i].label}
                  </span>
                </div>
              ) : null
            )}
          </div>
          {/* Delta arrows */}
          {pnls.filter((p) => p.revenue > 0).length >= 2 && (() => {
            const withData = pnls
              .map((p, i) => ({ p, i }))
              .filter(({ p }) => p.revenue > 0);
            if (withData.length < 2) return null;
            const last = withData[withData.length - 1].p;
            const prev = withData[withData.length - 2].p;
            const deltaEbit = last.ebit - prev.ebit;
            const deltaRev = last.revenue - prev.revenue;
            return (
              <div className="mt-4 flex gap-6 text-xs text-slate-600 border-t pt-3">
                <span>
                  Przychód MoM:{" "}
                  <strong
                    className={
                      deltaRev >= 0 ? "text-emerald-600" : "text-red-600"
                    }
                  >
                    {deltaRev >= 0 ? "+" : ""}
                    {fmtEur(deltaRev)}
                  </strong>
                </span>
                <span>
                  EBIT MoM:{" "}
                  <strong
                    className={
                      deltaEbit >= 0 ? "text-emerald-600" : "text-red-600"
                    }
                  >
                    {deltaEbit >= 0 ? "+" : ""}
                    {fmtEur(deltaEbit)}
                  </strong>
                </span>
              </div>
            );
          })()}
        </div>
      )}

      {/* Cost breakdown per month */}
      {anyData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {months.map((m, idx) => {
            const p = pnls[idx];
            if (!p.hasData) return null;
            const totalCosts = p.vehicleCosts + p.driverCosts + p.adminCosts;
            const slices = [
              { label: "Pojazdy", val: p.vehicleCosts, color: "bg-blue-400" },
              { label: "Kierowcy", val: p.driverCosts, color: "bg-indigo-400" },
              { label: "Administracja", val: p.adminCosts, color: "bg-purple-400" },
            ].filter((s) => s.val > 0);

            return (
              <div
                key={idx}
                className="bg-white rounded-xl border border-slate-200 shadow-sm p-4"
              >
                <h3 className="text-xs font-bold text-slate-500 uppercase mb-3">
                  Struktura kosztów · {m.label}
                </h3>
                {totalCosts > 0 ? (
                  <>
                    <div className="flex gap-0.5 h-3 rounded-full overflow-hidden mb-3">
                      {slices.map((s) => (
                        <div
                          key={s.label}
                          className={s.color}
                          style={{
                            width: `${(s.val / totalCosts) * 100}%`,
                          }}
                        />
                      ))}
                    </div>
                    <div className="space-y-1.5">
                      {slices.map((s) => (
                        <div
                          key={s.label}
                          className="flex items-center justify-between text-xs"
                        >
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`w-2.5 h-2.5 rounded-full ${s.color}`}
                            />
                            <span className="text-slate-500">{s.label}</span>
                          </div>
                          <div className="text-right">
                            <span className="font-medium text-slate-700">
                              {fmtEur(s.val)}
                            </span>
                            <span className="ml-1.5 text-slate-400">
                              {((s.val / totalCosts) * 100).toFixed(0)}%
                            </span>
                          </div>
                        </div>
                      ))}
                      <div className="border-t pt-1.5 flex justify-between text-xs font-semibold text-slate-700">
                        <span>RAZEM koszty</span>
                        <span>{fmtEur(totalCosts)}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-slate-400">
                    Załaduj pliki kosztów dla tego miesiąca.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Drivers detail */}
      {months.some((m) => m.odsLoaded) && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowDrivers((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-slate-50 hover:bg-slate-100"
          >
            <span className="text-sm font-bold text-slate-700 uppercase tracking-wider">
              👤 Zestawienie Kierowców
            </span>
            <span className="text-slate-400">{showDrivers ? "▲" : "▼"}</span>
          </button>

          {showDrivers && (
            <div className="p-4 space-y-6">
              {months.map((m, idx) => {
                if (!m.odsLoaded || !m.drivers) return null;
                const { drivers, totalPayout, driverCount } = m.drivers;
                return (
                  <div key={idx}>
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-xs font-bold text-slate-500 uppercase">
                        {m.label}
                      </h3>
                      <span className="text-xs text-slate-400">
                        {driverCount} kierowców · {fmtPln(totalPayout)} /{" "}
                        {fmtEur(m.driversCostEur)}
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium text-slate-500">
                              Kierowca
                            </th>
                            <th className="text-right px-3 py-2 font-medium text-slate-500">
                              St. dzienna
                            </th>
                            <th className="text-right px-3 py-2 font-medium text-slate-500">
                              Dni pr.
                            </th>
                            <th className="text-right px-3 py-2 font-medium text-slate-500">
                              Kwota pr.
                            </th>
                            <th className="text-right px-3 py-2 font-medium text-slate-500">
                              Urlop
                            </th>
                            <th className="text-right px-3 py-2 font-medium text-slate-500">
                              Obciąż.
                            </th>
                            <th className="text-right px-3 py-2 font-medium text-slate-700">
                              RAZEM
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {drivers.map((d) => (
                            <tr
                              key={d.sheetName}
                              className="border-t border-slate-100 hover:bg-slate-50"
                            >
                              <td className="px-3 py-1.5 font-medium text-slate-700">
                                {d.fullName}
                              </td>
                              <td className="text-right px-3 py-1.5 text-slate-500">
                                {d.dailyRate > 0
                                  ? d.dailyRate.toLocaleString("pl-PL")
                                  : "—"}
                              </td>
                              <td className="text-right px-3 py-1.5 text-slate-600">
                                {d.daysWorked}d
                              </td>
                              <td className="text-right px-3 py-1.5 text-slate-600">
                                {d.amountWork > 0
                                  ? d.amountWork.toLocaleString("pl-PL")
                                  : "—"}
                              </td>
                              <td className="text-right px-3 py-1.5 text-slate-500">
                                {d.daysVacation > 0
                                  ? `${d.daysVacation}d · ${d.amountVacation.toLocaleString("pl-PL")}`
                                  : "—"}
                              </td>
                              <td
                                className={`text-right px-3 py-1.5 ${
                                  d.deductions < 0
                                    ? "text-red-500"
                                    : "text-slate-400"
                                }`}
                              >
                                {d.deductions !== 0
                                  ? d.deductions.toLocaleString("pl-PL")
                                  : "—"}
                              </td>
                              <td className="text-right px-3 py-1.5 font-semibold text-slate-800">
                                {d.total.toLocaleString("pl-PL")}
                              </td>
                            </tr>
                          ))}
                          <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold">
                            <td
                              colSpan={6}
                              className="px-3 py-2 text-slate-700"
                            >
                              SUMA ({driverCount} kierowców)
                            </td>
                            <td className="text-right px-3 py-2 text-slate-800">
                              {fmtPln(totalPayout)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Admin detail */}
      {months.some((m) => m.adminLoaded) && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <button
            onClick={() => setShowAdmin((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-slate-50 hover:bg-slate-100"
          >
            <span className="text-sm font-bold text-slate-700 uppercase tracking-wider">
              🏢 Koszty Administracji
            </span>
            <span className="text-slate-400">{showAdmin ? "▲" : "▼"}</span>
          </button>

          {showAdmin && (
            <div className="p-4 space-y-6">
              {months.map((m, idx) => {
                if (!m.adminLoaded) return null;
                return (
                  <div key={idx}>
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-xs font-bold text-slate-500 uppercase">
                        {m.label}
                      </h3>
                      <span className="text-xs text-slate-400">
                        RAZEM: {fmtEur(m.adminTotal)}
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium text-slate-500 w-80">
                              Kategoria
                            </th>
                            <th className="text-right px-3 py-2 font-medium text-slate-500">
                              PLN
                            </th>
                            <th className="text-right px-3 py-2 font-medium text-slate-500">
                              EUR
                            </th>
                            <th className="w-24 px-3 py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.adminRows.map((row, ri) => (
                            <tr
                              key={ri}
                              className="border-t border-slate-100 hover:bg-slate-50"
                            >
                              <td className="px-3 py-1.5 text-slate-700">
                                {row.category}
                              </td>
                              <td className="text-right px-3 py-1.5 text-slate-600">
                                {fmtPln(row.amountPln)}
                              </td>
                              <td className="text-right px-3 py-1.5 font-medium text-slate-700">
                                {fmtEur(row.amountEur)}
                              </td>
                              <td className="px-3 py-1.5">
                                <div className="bg-slate-100 rounded-full h-1.5">
                                  <div
                                    className="bg-purple-400 h-1.5 rounded-full"
                                    style={{
                                      width: `${Math.min(
                                        100,
                                        (row.amountEur / m.adminTotal) * 100
                                      )}%`,
                                    }}
                                  />
                                </div>
                              </td>
                            </tr>
                          ))}
                          <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold">
                            <td className="px-3 py-2 text-slate-700">RAZEM</td>
                            <td className="text-right px-3 py-2 text-slate-800">
                              {fmtPln(
                                m.adminRows.reduce(
                                  (s, r) => s + r.amountPln,
                                  0
                                )
                              )}
                            </td>
                            <td className="text-right px-3 py-2 text-slate-800">
                              {fmtEur(m.adminTotal)}
                            </td>
                            <td />
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!anyData && (
        <div className="text-center py-20 text-slate-400">
          <div className="text-5xl mb-4">📤</div>
          <p className="text-lg font-medium text-slate-500">
            Załaduj pliki dla co najmniej jednego miesiąca
          </p>
          <p className="text-sm mt-1">
            TMS (przychody) + Kartoteka (koszty pojazdu) + ODS kierowców + Administracja
          </p>
        </div>
      )}
    </div>
  );
}
