"use client";

import { Fragment, useState, useRef, useCallback, useMemo } from "react";
import * as XLSX from "xlsx";
import {
  calcFuelCorrection,
  excelSerialToIso,
  PRICE_SERIES_LAST_DATE,
  type VehicleWeightClass,
} from "@/lib/fuelCorrection";

// ── Types ────────────────────────────────────────────────────

interface Order {
  nr: string;
  client: string;
  contractDate: number; // serial Excela
  execDate: number;     // serial Excela
  priceP: number;       // EUR — Fracht (baza do korekty)
}

/** "1234,56 EUR" | "1234.56" | number → number (EUR). PLN pozycje przeliczane po stałym fallbacku. */
function parseFrachtCell(val: unknown, plnEurFallback = 4.25): number {
  if (typeof val === "number") return val;
  const s = String(val ?? "").trim();
  if (!s) return 0;
  const m = s.match(/^([\d\s]+(?:[.,]\d+)?)\s*(EUR|PLN)?/i);
  if (!m) return 0;
  const num = parseFloat(m[1].replace(/\s/g, "").replace(",", ".")) || 0;
  if (m[2] && m[2].toUpperCase() === "PLN") return num / plnEurFallback;
  return num;
}

function parseRejestrFile(buffer: ArrayBuffer): { orders: Order[]; error?: string } {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });

  // Znajdź wiersz nagłówka (zawiera "Nr pełny" i "Zleceniodawca")
  let headerRow = -1;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = (rows[r] as unknown[]).map((v) => String(v ?? "").toLowerCase());
    if (row.some((s) => s.includes("nr pełny")) && row.some((s) => s.includes("zleceniodawca"))) {
      headerRow = r;
      break;
    }
  }
  if (headerRow === -1) return { orders: [], error: "Nie rozpoznano formatu — brak kolumn 'Nr pełny' / 'Zleceniodawca'." };

  const header = (rows[headerRow] as unknown[]).map((v) => String(v ?? "").toLowerCase().trim());
  const idx = (needle: string) => header.findIndex((h) => h === needle || h.includes(needle));

  const nrCol = idx("nr pełny");
  const clientCol = idx("zleceniodawca");
  const createdCol = idx("data utworzenia");
  const deliveredRealCol = header.findIndex((h) => h.includes("dostarczenie") && h.includes("rzeczyw"));
  const deliveredCol = header.findIndex((h) => h === "dostarczenie");
  const frachtNettoCol = header.findIndex((h) => h.includes("fracht eur netto"));
  const frachtWalCol = header.findIndex((h) => h.includes("fracht z walutą") || h.includes("fracht z waluta"));

  const orders: Order[] = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] as unknown[];
    if (!row || row.every((v) => v == null || v === "")) continue;

    const nr = nrCol >= 0 ? String(row[nrCol] ?? "").trim() : "";
    if (!nr) continue;

    const client = clientCol >= 0 ? String(row[clientCol] ?? "").trim() : "Nieznany";

    let fracht = frachtNettoCol >= 0 ? Number(row[frachtNettoCol]) || 0 : 0;
    if (!fracht && frachtWalCol >= 0) fracht = parseFrachtCell(row[frachtWalCol]);
    if (!fracht) continue;

    const deliveredVal = (deliveredRealCol >= 0 ? row[deliveredRealCol] : null) ?? (deliveredCol >= 0 ? row[deliveredCol] : null);
    const contractVal = createdCol >= 0 ? row[createdCol] : null;
    if (typeof deliveredVal !== "number" || typeof contractVal !== "number") continue;

    orders.push({ nr, client, contractDate: contractVal, execDate: deliveredVal, priceP: fracht });
  }

  return { orders };
}

// ── Formatting ───────────────────────────────────────────────

const fmtEur = (v: number) =>
  v.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

const fmtDate = (serial: number) => {
  const [y, m, d] = excelSerialToIso(serial).split("-");
  return `${d}.${m}.${y}`;
};

// ── Main Page ────────────────────────────────────────────────

export default function KorektyPaliwowePage() {
  const [orders, setOrders] = useState<Map<string, Order>>(new Map());
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [weightClass, setWeightClass] = useState<VehicleWeightClass>("ge20000");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedClient, setExpandedClient] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback((files: FileList) => {
    setLoading(true);
    setError(null);
    let pending = files.length;
    const newNames: string[] = [];
    const merged = new Map(orders);

    Array.from(files).forEach((f) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result instanceof ArrayBuffer) {
          const { orders: parsed, error: err } = parseRejestrFile(ev.target.result);
          if (err) setError((prev) => (prev ? prev + " | " : "") + `${f.name}: ${err}`);
          parsed.forEach((o) => merged.set(o.nr, o));
          newNames.push(f.name);
        }
        pending--;
        if (pending === 0) {
          setOrders(new Map(merged));
          setFileNames((prev) => Array.from(new Set([...prev, ...newNames])));
          setLoading(false);
        }
      };
      reader.readAsArrayBuffer(f);
    });
  }, [orders]);

  const clearAll = () => {
    setOrders(new Map());
    setFileNames([]);
    setError(null);
  };

  // ── Analysis ───────────────────────────────────────────────

  const analysis = useMemo(() => {
    const list = Array.from(orders.values());

    interface OrderRow extends Order {
      g: number | null;
      thresholdMet: boolean;
      deltaP: number | null;
    }
    interface ClientAgg {
      client: string;
      count: number;
      sumP: number;
      sumKnownP: number;
      deltaP: number;
      activeCount: number;
      orders: OrderRow[];
    }

    const byClient = new Map<string, ClientAgg>();

    for (const o of list) {
      let c = byClient.get(o.client);
      if (!c) {
        c = { client: o.client, count: 0, sumP: 0, sumKnownP: 0, deltaP: 0, activeCount: 0, orders: [] };
        byClient.set(o.client, c);
      }
      c.count++;
      c.sumP += o.priceP;

      const { g, thresholdMet, deltaP } = calcFuelCorrection(o.contractDate, o.execDate, o.priceP, weightClass);
      c.orders.push({ ...o, g, thresholdMet, deltaP });

      if (g !== null) {
        c.sumKnownP += o.priceP;
        if (deltaP !== null) c.deltaP += deltaP;
        if (thresholdMet) c.activeCount++;
      }
    }

    for (const c of byClient.values()) c.orders.sort((a, b) => a.execDate - b.execDate);

    const clients = Array.from(byClient.values()).sort((a, b) => Math.abs(b.deltaP) - Math.abs(a.deltaP));
    const grand = {
      count: list.length,
      sumP: clients.reduce((s, c) => s + c.sumP, 0),
      sumKnownP: clients.reduce((s, c) => s + c.sumKnownP, 0),
      deltaP: clients.reduce((s, c) => s + c.deltaP, 0),
    };

    return { clients, grand };
  }, [orders, weightClass]);

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">⛽ Korekta Paliwowa — wszyscy klienci</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Wg oficjalnego wskaźnika G liczonego z TYGODNIOWEJ ceny referencyjnej ON (Ministerio de Transportes,
          Hiszpania) — Ley 15/2009 art. 38 + Orden FOM/1882/2012 cond. 3, zaktualizowana RDL 9/2026 i 18/2026.
          Ostatnia opublikowana cena tygodniowa: <strong>{fmtDate(PRICE_SERIES_LAST_DATE)}</strong> — zlecenia
          z późniejszą datą realizacji lub kontraktu pokażą brak danych, dopóki seria nie zostanie odświeżona.
        </p>
      </div>

      {/* Upload */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => inputRef.current?.click()}
            disabled={loading}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-dashed border-slate-300 text-slate-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50"
          >
            📂 {loading ? "Wczytywanie…" : "Wgraj rejestr(y) transportów (.xls/.xlsx)"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".xls,.xlsx"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = ""; }}
          />

          <label className="flex items-center gap-2 text-xs text-slate-500">
            Kategoria wagowa floty:
            <select
              value={weightClass}
              onChange={(e) => setWeightClass(e.target.value as VehicleWeightClass)}
              className="border border-slate-200 rounded px-2 py-1 text-xs text-slate-700"
            >
              <option value="ge20000">≥ 20 000 kg — coef. 0,40 (standardowe TIR-y, od RDL 9/2026)</option>
              <option value="35to20000">3 500–20 000 kg — coef. 0,20 (niezweryfikowane po RDL 9/2026)</option>
              <option value="construction">Budowlane &gt; 3 500 kg — coef. 0,20 (niezweryfikowane po RDL 9/2026)</option>
              <option value="le3500">≤ 3 500 kg — coef. 0,10 (niezweryfikowane po RDL 9/2026)</option>
            </select>
          </label>

          {fileNames.length > 0 && (
            <button onClick={clearAll} className="ml-auto text-xs text-red-500 hover:underline">
              ✕ Wyczyść ({fileNames.length} plik{fileNames.length === 1 ? "" : "i"})
            </button>
          )}
        </div>

        {fileNames.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {fileNames.map((n) => (
              <span key={n} className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2.5 py-0.5">
                ✅ {n}
              </span>
            ))}
          </div>
        )}

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
      </div>

      {orders.size > 0 && (
        <>
          {/* Grand summary */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <div className="text-xs font-bold text-slate-500 uppercase mb-1">Zleceń (unikalnych)</div>
              <div className="text-2xl font-bold text-slate-800">{analysis.grand.count.toLocaleString("pl-PL")}</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <div className="text-xs font-bold text-slate-500 uppercase mb-1">Suma frachtu</div>
              <div className="text-2xl font-bold text-slate-800">{fmtEur(analysis.grand.sumP)}</div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <div className="text-xs font-bold text-slate-500 uppercase mb-1">Baza z policzalnym G</div>
              <div className="text-2xl font-bold text-slate-600">
                {fmtEur(analysis.grand.sumKnownP)}
                <span className="text-xs font-normal text-slate-400 ml-1">
                  ({analysis.grand.sumP > 0 ? ((analysis.grand.sumKnownP / analysis.grand.sumP) * 100).toFixed(1) : 0}%)
                </span>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <div className="text-xs font-bold text-slate-500 uppercase mb-1">Korekta razem (ΔP)</div>
              <div className={`text-2xl font-bold ${analysis.grand.deltaP >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                {analysis.grand.deltaP >= 0 ? "+" : ""}{fmtEur(analysis.grand.deltaP)}
              </div>
            </div>
          </div>

          <div className="text-xs text-slate-400 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
            ℹ️ G liczone jest osobno dla każdego zlecenia, z dokładnej daty zawarcia umowy i dokładnej daty realizacji
            — łącznie z parami w tym samym miesiącu (to była wcześniejsza wada przybliżenia miesięcznego). Próg
            aktywacji: |G| ≥ 5%. Wartość ujemna ΔP = zwrot na rzecz klienta, dodatnia = dopłata należna od klienta.
            Zlecenia z datą poza opublikowaną serią cenową liczą się jako "brak danych" i nie wchodzą do korekty.
          </div>

          {/* Per-client table */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">📋 Korekta wg klienta</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="px-4 py-2.5 font-medium"></th>
                    <th className="px-4 py-2.5 font-medium">Klient</th>
                    <th className="px-4 py-2.5 font-medium text-right">Zleceń</th>
                    <th className="px-4 py-2.5 font-medium text-right">Suma frachtu</th>
                    <th className="px-4 py-2.5 font-medium text-right">Baza z G</th>
                    <th className="px-4 py-2.5 font-medium text-right">Aktywnych (≥5%)</th>
                    <th className="px-4 py-2.5 font-medium text-right">Korekta ΔP</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.clients.map((c) => (
                    <Fragment key={c.client}>
                      <tr
                        onClick={() => setExpandedClient(expandedClient === c.client ? null : c.client)}
                        className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                      >
                        <td className="px-4 py-2.5 text-slate-400 text-xs">{expandedClient === c.client ? "▲" : "▼"}</td>
                        <td className="px-4 py-2.5 text-slate-800 font-medium">{c.client}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{c.count}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{fmtEur(c.sumP)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-400 text-xs">{fmtEur(c.sumKnownP)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{c.activeCount}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${c.deltaP > 0 ? "text-emerald-600" : c.deltaP < 0 ? "text-red-600" : "text-slate-400"}`}>
                          {c.deltaP !== 0 ? (c.deltaP >= 0 ? "+" : "") + fmtEur(c.deltaP) : "—"}
                        </td>
                      </tr>
                      {expandedClient === c.client && (
                        <tr>
                          <td colSpan={7} className="bg-slate-50 px-4 py-3">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-slate-500 text-left border-b border-slate-200">
                                  <th className="py-1.5 pr-3">Nr zlecenia</th>
                                  <th className="py-1.5 pr-3">Kontrakt</th>
                                  <th className="py-1.5 pr-3">Realizacja</th>
                                  <th className="py-1.5 pr-3 text-right">Fracht P</th>
                                  <th className="py-1.5 pr-3 text-right">G</th>
                                  <th className="py-1.5 pr-3 text-right">Próg 5%</th>
                                  <th className="py-1.5 text-right">ΔP</th>
                                </tr>
                              </thead>
                              <tbody>
                                {c.orders.map((o) => (
                                  <tr key={o.nr} className="border-b border-slate-100">
                                    <td className="py-1 pr-3 text-slate-700 font-mono">{o.nr}</td>
                                    <td className="py-1 pr-3 text-slate-500">{fmtDate(o.contractDate)}</td>
                                    <td className="py-1 pr-3 text-slate-700">{fmtDate(o.execDate)}</td>
                                    <td className="py-1 pr-3 text-right text-slate-600">{fmtEur(o.priceP)}</td>
                                    <td className="py-1 pr-3 text-right text-slate-600">
                                      {o.g !== null ? `${o.g >= 0 ? "+" : ""}${o.g.toFixed(2)}%` : <span className="text-slate-300">brak</span>}
                                    </td>
                                    <td className="py-1 pr-3 text-right">
                                      {o.g === null ? "—" : o.thresholdMet ? <span className="text-emerald-600">TAK</span> : <span className="text-slate-400">nie</span>}
                                    </td>
                                    <td className={`py-1 text-right font-medium ${(o.deltaP ?? 0) > 0 ? "text-emerald-600" : (o.deltaP ?? 0) < 0 ? "text-red-600" : "text-slate-400"}`}>
                                      {o.deltaP ? (o.deltaP >= 0 ? "+" : "") + fmtEur(o.deltaP) : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {orders.size === 0 && !loading && (
        <div className="text-center text-slate-400 text-sm py-12">
          Wgraj co najmniej jeden plik Rejestru Transportów, żeby zobaczyć korektę paliwową dla wszystkich klientów.
        </div>
      )}
    </div>
  );
}
