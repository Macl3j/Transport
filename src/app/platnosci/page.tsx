"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";

// ── Types ────────────────────────────────────────────────────

interface CostInvoice {
  id: string;
  numer: string | null;
  sprzedawca: string | null;
  typ_kosztu: string | null;
  status_splaty: string | null;
  data_wystawienia: string | null; // ISO date
  termin_platnosci: string | null; // ISO date
  data_zaplaty: string | null;     // ISO date
  brutto_pln: number | null;
  pozostalo_do_zaplaty_pln: number | null;
  pojazd_reg: string | null;
  kraj_sprzedawcy: string | null;
}

// ── Kategorie ryzyka — bazujące na realnej historii płatności ──
// (patrz analiza pliku "koszty wszystkie" — 10 125 faktur 2024-2026)
const RISK_INFO: Record<string, { icon: string; label: string; weight: number }> = {
  "ON":                             { icon: "🔴", label: "operacyjne — blokada karty paliwowej", weight: 3 },
  "Autostrady":                     { icon: "🔴", label: "operacyjne — blokada myta", weight: 3 },
  "Parkingi":                       { icon: "🔴", label: "operacyjne", weight: 3 },
  "AdBlue":                         { icon: "🔴", label: "operacyjne", weight: 3 },
  "Podatek od środków transportu":  { icon: "🟠", label: "podatkowe — ryzyko odsetek/kontroli", weight: 2.5 },
  "Faktura przewoźnika":            { icon: "🟡", label: "relacyjne — podwykonawca", weight: 2 },
};
const RISK_DEFAULT = { icon: "🟢", label: "bezpieczne do negocjacji", weight: 1 };
function riskOf(typ: string | null) { return RISK_INFO[typ ?? ""] ?? RISK_DEFAULT; }

// ── Helpers ──────────────────────────────────────────────────
function toIso(v: unknown): string | null {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "number" && v > 1000) {
    const d = new Date((v - 25569) * 86400 * 1000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  return Math.round((b - a) / 86400000);
}
function fmtPln(n: number) {
  return Math.round(n).toLocaleString("pl-PL") + " PLN";
}
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
const TODAY_ISO = new Date().toISOString().slice(0, 10);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

// ── Import — parsowanie eksportu faktur kosztowych ─────────────
function parseCostFile(buffer: ArrayBuffer): { rows: Omit<CostInvoice, "id">[]; error?: string } {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array", cellDates: true });
  // Preferuj arkusz "Sheet" (surowe dane), fallback: arkusz z największą liczbą wierszy
  let sheetName = wb.SheetNames.includes("Sheet") ? "Sheet" : wb.SheetNames[0];
  if (!wb.SheetNames.includes("Sheet")) {
    let best = wb.SheetNames[0], bestLen = 0;
    for (const n of wb.SheetNames) {
      const len = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }).length;
      if (len > bestLen) { bestLen = len; best = n; }
    }
    sheetName = best;
  }
  const ws = wb.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });

  let headerRow = -1;
  for (let r = 0; r < Math.min(raw.length, 5); r++) {
    const row = (raw[r] as unknown[]).map(v => String(v ?? ""));
    if (row.includes("Numer") && row.includes("Sprzedawca") && row.includes("Termin płatności")) {
      headerRow = r;
      break;
    }
  }
  if (headerRow === -1) return { rows: [], error: "Nie rozpoznano formatu — brak kolumn 'Numer' / 'Sprzedawca' / 'Termin płatności'." };

  const header = (raw[headerRow] as unknown[]).map(v => String(v ?? ""));
  const idx = (name: string) => header.indexOf(name);
  const col = {
    numer:        idx("Numer"),
    sprzedawca:   idx("Sprzedawca"),
    typ:          idx("Typ kosztu"),
    status:       idx("Status spłaty"),
    wystawienia:  idx("Data wystawienia"),
    termin:       idx("Termin płatności"),
    zaplata:      idx("Data zapłaty"),
    brutto:       idx("Brutto PLN"),
    pozostalo:    idx("Pozostało do zapłaty w PLN"),
    pojazd:       idx("Pojazd nr rej"),
    kraj:         idx("Kraj sprzedawcy"),
  };

  const rows: Omit<CostInvoice, "id">[] = [];
  for (let r = headerRow + 1; r < raw.length; r++) {
    const row = raw[r] as unknown[];
    if (!row || row.length === 0) continue;
    rows.push({
      numer: strOrNull(row[col.numer]),
      sprzedawca: strOrNull(row[col.sprzedawca]),
      typ_kosztu: strOrNull(row[col.typ]),
      status_splaty: strOrNull(row[col.status]),
      data_wystawienia: toIso(row[col.wystawienia]),
      termin_platnosci: toIso(row[col.termin]),
      data_zaplaty: toIso(row[col.zaplata]),
      brutto_pln: numOrNull(row[col.brutto]),
      pozostalo_do_zaplaty_pln: numOrNull(row[col.pozostalo]),
      pojazd_reg: strOrNull(row[col.pojazd]),
      kraj_sprzedawcy: strOrNull(row[col.kraj]),
    });
  }
  return { rows };
}

// ── Statystyki opóźnień: dostawca × kategoria ───────────────────
interface DelayStats {
  n: number;
  avg: number;
  p75: number;
  p90: number;
  lateCount: number;
}
function computeDelayStats(invoices: CostInvoice[]): Map<string, DelayStats> {
  const buckets = new Map<string, number[]>();
  for (const inv of invoices) {
    if (!inv.termin_platnosci || !inv.data_zaplaty) continue;
    const key = `${inv.sprzedawca ?? ""}||${inv.typ_kosztu ?? ""}`;
    const delay = daysBetween(inv.termin_platnosci, inv.data_zaplaty);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(delay);
  }
  const out = new Map<string, DelayStats>();
  for (const [key, delays] of buckets) {
    const sorted = [...delays].sort((a, b) => a - b);
    out.set(key, {
      n: delays.length,
      avg: delays.reduce((a, b) => a + b, 0) / delays.length,
      p75: percentile(sorted, 0.75),
      p90: percentile(sorted, 0.90),
      lateCount: delays.filter(d => d > 0).length,
    });
  }
  return out;
}
// Fallback stats per kategoria (gdy dostawca ma za mało historii)
function computeCategoryStats(invoices: CostInvoice[]): Map<string, DelayStats> {
  const buckets = new Map<string, number[]>();
  for (const inv of invoices) {
    if (!inv.termin_platnosci || !inv.data_zaplaty) continue;
    const key = inv.typ_kosztu ?? "";
    const delay = daysBetween(inv.termin_platnosci, inv.data_zaplaty);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(delay);
  }
  const out = new Map<string, DelayStats>();
  for (const [key, delays] of buckets) {
    const sorted = [...delays].sort((a, b) => a - b);
    out.set(key, {
      n: delays.length,
      avg: delays.reduce((a, b) => a + b, 0) / delays.length,
      p75: percentile(sorted, 0.75),
      p90: percentile(sorted, 0.90),
      lateCount: delays.filter(d => d > 0).length,
    });
  }
  return out;
}

type Tab = "przeglad" | "kalendarz" | "dostawca" | "import";

export default function PlatnosciPage() {
  const [tab, setTab] = useState<Tab>("przeglad");
  const [invoices, setInvoices] = useState<CostInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [vendorQuery, setVendorQuery] = useState("");
  const [selectedVendor, setSelectedVendor] = useState<string | null>(null);

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    let all: CostInvoice[] = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("cost_invoices")
        .select("id,numer,sprzedawca,typ_kosztu,status_splaty,data_wystawienia,termin_platnosci,data_zaplaty,brutto_pln,pozostalo_do_zaplaty_pln,pojazd_reg,kraj_sprzedawcy")
        .range(from, from + pageSize - 1);
      if (error || !data) break;
      all = all.concat(data as CostInvoice[]);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    setInvoices(all);
    setLoading(false);
  }, []);

  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  const handleImportFile = useCallback((file: File) => {
    setImporting(true);
    setImportMsg(null);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const buf = ev.target?.result as ArrayBuffer;
        const { rows, error } = parseCostFile(buf);
        if (error) { setImportMsg({ ok: false, text: error }); setImporting(false); return; }
        if (rows.length === 0) { setImportMsg({ ok: false, text: "Brak wierszy do zaimportowania." }); setImporting(false); return; }

        // Import zastępuje pełny zbiór — plik to zawsze aktualny, pełny eksport.
        const { error: delErr } = await supabase.from("cost_invoices").delete().gte("imported_at", "1900-01-01");
        if (delErr) throw delErr;

        let imported = 0;
        for (let i = 0; i < rows.length; i += 500) {
          const batch = rows.slice(i, i + 500);
          const { error: insErr } = await supabase.from("cost_invoices").insert(batch as never[]);
          if (insErr) throw insErr;
          imported += batch.length;
        }
        setImportMsg({ ok: true, text: `Zaimportowano ${imported} faktur (arkusz rozpoznany automatycznie).` });
        await loadInvoices();
      } catch (err: unknown) {
        setImportMsg({ ok: false, text: `Błąd importu: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        setImporting(false);
      }
    };
    reader.readAsArrayBuffer(file);
  }, [loadInvoices]);

  const delayByVendorCat = useMemo(() => computeDelayStats(invoices), [invoices]);
  const delayByCat = useMemo(() => computeCategoryStats(invoices), [invoices]);

  function bufferFor(sprzedawca: string | null, typ: string | null): { p75: number; source: "dostawca" | "kategoria" | "brak" } {
    const vendorKey = `${sprzedawca ?? ""}||${typ ?? ""}`;
    const vStats = delayByVendorCat.get(vendorKey);
    if (vStats && vStats.n >= 3) return { p75: vStats.p75, source: "dostawca" };
    const cStats = delayByCat.get(typ ?? "");
    if (cStats && cStats.n >= 3) return { p75: cStats.p75, source: "kategoria" };
    return { p75: 14, source: "brak" };
  }

  // ── Faktury aktualnie nierozliczone ───────────────────────────
  const outstanding = useMemo(() => {
    return invoices.filter(inv => {
      if (inv.status_splaty === "Spłacony") return false;
      if (inv.pozostalo_do_zaplaty_pln != null && inv.pozostalo_do_zaplaty_pln <= 0.01) return false;
      return true;
    });
  }, [invoices]);

  const outstandingByType = useMemo(() => {
    const m = new Map<string, number>();
    for (const inv of outstanding) {
      const key = inv.typ_kosztu ?? "(brak)";
      const amt = inv.pozostalo_do_zaplaty_pln ?? inv.brutto_pln ?? 0;
      m.set(key, (m.get(key) ?? 0) + amt);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [outstanding]);

  const totalOutstanding = outstandingByType.reduce((s, [, v]) => s + v, 0);

  // Aging buckets wg terminu płatności
  const aging = useMemo(() => {
    const buckets = { current: 0, d30: 0, d90: 0, d90plus: 0 };
    for (const inv of outstanding) {
      const amt = inv.pozostalo_do_zaplaty_pln ?? inv.brutto_pln ?? 0;
      if (!inv.termin_platnosci) { buckets.current += amt; continue; }
      const d = daysBetween(inv.termin_platnosci, TODAY_ISO);
      if (d <= 0) buckets.current += amt;
      else if (d <= 30) buckets.d30 += amt;
      else if (d <= 90) buckets.d90 += amt;
      else buckets.d90plus += amt;
    }
    return buckets;
  }, [outstanding]);

  // ── Kalendarz wymagalności — priorytetyzacja ──────────────────
  const prioritized = useMemo(() => {
    return outstanding.map(inv => {
      const d = inv.termin_platnosci ? daysBetween(inv.termin_platnosci, TODAY_ISO) : 0;
      const risk = riskOf(inv.typ_kosztu);
      const buf = bufferFor(inv.sprzedawca, inv.typ_kosztu);
      const overBuffer = buf.p75 > 0 ? d / buf.p75 : (d > 0 ? 2 : 0);
      const score = risk.weight * Math.max(0, overBuffer) + (d > 0 ? risk.weight * 0.2 : 0);
      let statusLabel: string, statusColor: string;
      if (d <= 0) { statusLabel = `termin za ${-d} dni`; statusColor = "text-slate-500"; }
      else if (d <= buf.p75) { statusLabel = `w granicach bufora (margines ~${Math.round(buf.p75 - d)} dni)`; statusColor = "text-amber-600"; }
      else { statusLabel = `PRZEKROCZONY bufor o ${Math.round(d - buf.p75)} dni`; statusColor = "text-red-600 font-semibold"; }
      return { inv, daysOverdue: d, risk, buf, score, statusLabel, statusColor };
    }).sort((a, b) => b.score - a.score);
  }, [outstanding, delayByVendorCat, delayByCat]);

  type CalSortKey = "priorytet" | "dostawca" | "kategoria" | "kwota" | "termin" | "bufor";
  // Kierunek sortowania przy pierwszym kliknięciu — intuicyjny per kolumna
  // (tekst: A→Z, kwota/priorytet/bufor: od największych, termin: od najwcześniejszego).
  const CAL_DEFAULT_DESC: Record<CalSortKey, boolean> = {
    priorytet: true, dostawca: false, kategoria: false, kwota: true, termin: false, bufor: true,
  };
  const [calSortKey, setCalSortKey] = useState<CalSortKey>("priorytet");
  const [calSortDesc, setCalSortDesc] = useState(true);
  function toggleCalSort(key: CalSortKey) {
    if (calSortKey === key) setCalSortDesc(d => !d);
    else { setCalSortKey(key); setCalSortDesc(CAL_DEFAULT_DESC[key]); }
  }
  function CalSortIcon({ k }: { k: CalSortKey }) {
    if (calSortKey !== k) return <span className="text-slate-300">↕</span>;
    return <span className="text-slate-600">{calSortDesc ? "↓" : "↑"}</span>;
  }
  const sortedPrioritized = useMemo(() => {
    const arr = [...prioritized];
    const cmp: Record<CalSortKey, (a: typeof arr[0], b: typeof arr[0]) => number> = {
      priorytet: (a, b) => a.score - b.score,
      dostawca:  (a, b) => (a.inv.sprzedawca ?? "").localeCompare(b.inv.sprzedawca ?? ""),
      kategoria: (a, b) => (a.inv.typ_kosztu ?? "").localeCompare(b.inv.typ_kosztu ?? ""),
      kwota:     (a, b) => (a.inv.pozostalo_do_zaplaty_pln ?? a.inv.brutto_pln ?? 0) - (b.inv.pozostalo_do_zaplaty_pln ?? b.inv.brutto_pln ?? 0),
      termin:    (a, b) => (a.inv.termin_platnosci ?? "").localeCompare(b.inv.termin_platnosci ?? ""),
      bufor:     (a, b) => a.buf.p75 - b.buf.p75,
    };
    arr.sort(cmp[calSortKey]);
    if (calSortDesc) arr.reverse();
    return arr;
  }, [prioritized, calSortKey, calSortDesc]);

  // ── Zakładka Dostawca ─────────────────────────────────────────
  const vendorList = useMemo(() => {
    const s = new Set<string>();
    for (const inv of invoices) if (inv.sprzedawca) s.add(inv.sprzedawca);
    return [...s].sort();
  }, [invoices]);
  const filteredVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendorList;
    return vendorList.filter(v => v.toLowerCase().includes(q));
  }, [vendorList, vendorQuery]);
  const vendorInvoices = useMemo(() => {
    if (!selectedVendor) return [];
    return invoices.filter(inv => inv.sprzedawca === selectedVendor)
      .sort((a, b) => (b.termin_platnosci ?? "").localeCompare(a.termin_platnosci ?? ""));
  }, [invoices, selectedVendor]);
  const vendorCatStats = useMemo(() => {
    if (!selectedVendor) return [];
    const cats = new Set(vendorInvoices.map(i => i.typ_kosztu ?? "(brak)"));
    return [...cats].map(cat => {
      const stats = delayByVendorCat.get(`${selectedVendor}||${cat === "(brak)" ? "" : cat}`);
      const outstandingAmt = vendorInvoices
        .filter(i => (i.typ_kosztu ?? "(brak)") === cat && i.status_splaty !== "Spłacony" && (i.pozostalo_do_zaplaty_pln ?? 0) > 0.01)
        .reduce((s, i) => s + (i.pozostalo_do_zaplaty_pln ?? 0), 0);
      return { cat, stats, outstandingAmt };
    });
  }, [selectedVendor, vendorInvoices, delayByVendorCat]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">💰 Płatności — wymagalność faktur kosztowych</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Priorytetyzacja płatności bazująca na realnej historii ({invoices.length.toLocaleString("pl-PL")} faktur w bazie) —
          dla każdego dostawcy i kategorii kosztu liczymy, ile dni historycznie faktycznie mijało między terminem a datą zapłaty.
        </p>
      </div>

      <div className="flex gap-1 bg-slate-100 rounded-lg p-1 w-fit">
        {([
          ["przeglad", "📊 Przegląd"],
          ["kalendarz", "📅 Kalendarz wymagalności"],
          ["dostawca", "🏢 Dostawca"],
          ["import", "📂 Import"],
        ] as [Tab, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === key ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-slate-400">Wczytywanie…</p>}

      {!loading && tab === "przeglad" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Razem nierozliczone</div>
              <div className="text-xl font-bold text-slate-800">{fmtPln(totalOutstanding)}</div>
              <div className="text-xs text-slate-400">{outstanding.length} faktur</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Bieżące (termin nie minął)</div>
              <div className="text-xl font-bold text-emerald-600">{fmtPln(aging.current)}</div>
            </div>
            <div className="bg-white border border-amber-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Przeterminowane 1–90 dni</div>
              <div className="text-xl font-bold text-amber-600">{fmtPln(aging.d30 + aging.d90)}</div>
            </div>
            <div className="bg-white border border-red-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Przeterminowane 90+ dni</div>
              <div className="text-xl font-bold text-red-600">{fmtPln(aging.d90plus)}</div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-sm font-semibold text-slate-700">
              Nierozliczone wg kategorii
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                  <th className="px-4 py-2 font-medium">Kategoria</th>
                  <th className="px-4 py-2 font-medium">Ryzyko</th>
                  <th className="px-4 py-2 font-medium text-right">Kwota nierozliczona</th>
                </tr>
              </thead>
              <tbody>
                {outstandingByType.map(([typ, amt]) => {
                  const r = riskOf(typ === "(brak)" ? null : typ);
                  return (
                    <tr key={typ} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="px-4 py-2 font-medium text-slate-700">{typ}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{r.icon} {r.label}</td>
                      <td className="px-4 py-2 text-right font-mono">{fmtPln(amt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && tab === "kalendarz" && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-sm font-semibold text-slate-700 flex items-center justify-between">
            <span>Kalendarz wymagalności — domyślnie wg priorytetu (nie samego terminu), kliknij nagłówek by zmienić</span>
            <span className="text-xs text-slate-400 font-normal">{prioritized.length} faktur</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                  <th className="px-4 py-2 font-medium cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCalSort("dostawca")}>Dostawca <CalSortIcon k="dostawca" /></th>
                  <th className="px-4 py-2 font-medium cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCalSort("kategoria")}>Kategoria <CalSortIcon k="kategoria" /></th>
                  <th className="px-4 py-2 font-medium text-right cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCalSort("kwota")}>Kwota <CalSortIcon k="kwota" /></th>
                  <th className="px-4 py-2 font-medium cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCalSort("termin")}>Termin <CalSortIcon k="termin" /></th>
                  <th className="px-4 py-2 font-medium cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCalSort("bufor")}>Bufor historyczny (p75) <CalSortIcon k="bufor" /></th>
                  <th className="px-4 py-2 font-medium cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCalSort("priorytet")}>Status / priorytet <CalSortIcon k="priorytet" /></th>
                </tr>
              </thead>
              <tbody>
                {sortedPrioritized.slice(0, 200).map(({ inv, buf, statusLabel, statusColor, risk }) => (
                  <tr key={inv.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium text-slate-700">{inv.sprzedawca ?? "—"}</td>
                    <td className="px-4 py-2 text-xs">{risk.icon} {inv.typ_kosztu ?? "—"}</td>
                    <td className="px-4 py-2 text-right font-mono">{fmtPln(inv.pozostalo_do_zaplaty_pln ?? inv.brutto_pln ?? 0)}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{fmtDate(inv.termin_platnosci)}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {Math.round(buf.p75)} dni <span className="text-slate-300">({buf.source})</span>
                    </td>
                    <td className={`px-4 py-2 text-xs ${statusColor}`}>{statusLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && tab === "dostawca" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
            <input
              type="text" value={vendorQuery}
              onChange={e => setVendorQuery(e.target.value)}
              placeholder="Szukaj dostawcy…"
              className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="text-xs text-slate-400 px-1">{filteredVendors.length} / {vendorList.length} dostawców</div>
            <div className="max-h-[60vh] overflow-y-auto divide-y divide-slate-50">
              {filteredVendors.map(v => (
                <button key={v} onClick={() => setSelectedVendor(v)}
                  className={`w-full text-left px-2 py-1.5 text-sm rounded-md ${selectedVendor === v ? "bg-blue-50 text-blue-700 font-medium" : "hover:bg-slate-50 text-slate-600"}`}>
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div className="md:col-span-2 space-y-4">
            {!selectedVendor && <p className="text-sm text-slate-400 p-4">Wybierz dostawcę z listy po lewej.</p>}
            {selectedVendor && (
              <>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-sm font-semibold text-slate-700 mb-2">{selectedVendor} — historia wg kategorii</div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                        <th className="py-1.5 font-medium">Kategoria</th>
                        <th className="py-1.5 font-medium text-right">Śr. opóźnienie</th>
                        <th className="py-1.5 font-medium text-right">p75 / p90</th>
                        <th className="py-1.5 font-medium text-right">Nierozliczone</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorCatStats.map(({ cat, stats, outstandingAmt }) => (
                        <tr key={cat} className="border-b border-slate-50">
                          <td className="py-1.5">{riskOf(cat === "(brak)" ? null : cat).icon} {cat}</td>
                          <td className="py-1.5 text-right font-mono">{stats ? `${stats.avg.toFixed(1)}d` : "—"}</td>
                          <td className="py-1.5 text-right font-mono text-xs text-slate-500">
                            {stats ? `${Math.round(stats.p75)}d / ${Math.round(stats.p90)}d` : "—"}
                          </td>
                          <td className="py-1.5 text-right font-mono">{outstandingAmt > 0 ? fmtPln(outstandingAmt) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-sm font-semibold text-slate-700">
                    Ostatnie faktury ({vendorInvoices.length})
                  </div>
                  <div className="max-h-[40vh] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                          <th className="px-4 py-1.5 font-medium">Numer</th>
                          <th className="px-4 py-1.5 font-medium">Termin</th>
                          <th className="px-4 py-1.5 font-medium">Zapłata</th>
                          <th className="px-4 py-1.5 font-medium text-right">Kwota</th>
                          <th className="px-4 py-1.5 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vendorInvoices.slice(0, 100).map(inv => (
                          <tr key={inv.id} className="border-b border-slate-50">
                            <td className="px-4 py-1.5 text-xs text-slate-500">{inv.numer ?? "—"}</td>
                            <td className="px-4 py-1.5 text-xs">{fmtDate(inv.termin_platnosci)}</td>
                            <td className="px-4 py-1.5 text-xs">{fmtDate(inv.data_zaplaty)}</td>
                            <td className="px-4 py-1.5 text-right font-mono">{fmtPln(inv.brutto_pln ?? 0)}</td>
                            <td className="px-4 py-1.5 text-xs">{inv.status_splaty ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "import" && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3 max-w-2xl">
          <div>
            <div className="text-sm font-semibold text-amber-800">📂 Import eksportu faktur kosztowych</div>
            <p className="text-xs text-amber-700 mt-1">
              Wgraj pełny eksport z systemu FK (arkusz z kolumnami: Numer, Sprzedawca, Typ kosztu, Status spłaty,
              Data wystawienia, Termin płatności, Data zapłaty, Brutto PLN, Pozostało do zapłaty w PLN…).
              Import <strong>zastępuje cały dotychczasowy zbiór</strong> — wgrywaj zawsze najbardziej aktualny, pełny eksport.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => fileRef.current?.click()} disabled={importing}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed border-amber-400 text-amber-800 hover:bg-amber-100 disabled:opacity-50">
              📂 {importing ? "Importowanie…" : "Wgraj plik XLSX"}
            </button>
            <input ref={fileRef} type="file" accept=".xls,.xlsx" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ""; }} />
          </div>
          {importMsg && (
            <div className={`text-xs rounded-lg px-3 py-2 border ${importMsg.ok ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}`}>
              {importMsg.text}
            </div>
          )}
          <div className="text-xs text-amber-600 pt-2 border-t border-amber-200">
            W bazie obecnie: <strong>{invoices.length.toLocaleString("pl-PL")}</strong> faktur.
          </div>
        </div>
      )}
    </div>
  );
}
