"use client";

import { useState, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { calculateRoute, profitabilityLabel, euroClass as deriveEuroClass, FLEET } from "@/lib/calculator";
import { useSettings } from "@/lib/settings-context";

interface OrsVerification {
  distanceKm: number;
  tollEur: number;
  durationH: number;
  diffKm: number;       // ors - tms (km)
  diffKmPct: number;    // %
  status: "ok" | "warn" | "alert" | "error";
  error?: string;
}

interface RouteRow {
  orderNr: string;
  client: string;
  vehicle: string;
  originCountry: string;
  destCountry: string;
  originCity: string;
  destCity: string;
  distanceKm: number;
  emptyKm?: number;
  totalKm: number;    // distanceKm + emptyKm
  frachtRaw: string;
  frachtEur: number;
  frachtEstimated: boolean;   // true when fracht=0 in TMS → estimated from TMS margin/km
  noFreightData: boolean;     // true when fracht=0 AND no TMS margin/km — unknown revenue
  currency: string;
  avgFuelL100: number;
  tmsMarzaPerKm: number;      // "Marża EUR na 1 KM z mapy" from TMS
  marginEur: number;
  marginPct: number;
  costPerKm: number;
  revenuePerKm: number;
  totalCost: number;
  tollCost: number;       // EUR — myto (z TMS lub macierzy)
  tollFromTms: boolean;   // true = rzeczywiste myto z TMS, false = macierz
  label: string;
  labelColor: string;
  euroClass: number;      // 3 | 4 | 5 | 6 — derived from vehicle year
  ors?: OrsVerification;
  // Kontynuacja trasy — ten sam ciągnik, ten sam dzień
  isContinuation: boolean;     // true gdy ciągnik ma >1 zlecenie w tym samym dniu
  perDobeShareFactor: number;  // udział w dniówce (0–1), proporcjonalny do km
  tripDate: string;            // YYYY-MM-DD (data podjęcia) — do grupowania
}

// Normalizuje datę z TMS (serial Excel lub string) do YYYY-MM-DD dla grupowania
function toDateKey(s: string): string {
  if (!s) return "";
  // Excel serial number
  const n = parseFloat(s);
  if (!isNaN(n) && n > 40000) {
    const d = new Date((n - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }
  // TMS format: "DD-MM-YYYY HH:MM" or "DD-MM-YYYY"
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  // ISO or other JS-parseable
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // fallback: pierwsze 10 znaków
  return s.length >= 10 ? s.slice(0, 10) : "";
}

/** Parse TMS/Excel date string → Unix ms timestamp (zachowuje czas HH:MM dla ułamkowych dni) */
function toTimestamp(s: string): number | undefined {
  if (!s) return undefined;
  const n = parseFloat(s);
  if (!isNaN(n) && n > 40000) return Math.round((n - 25569) * 86400 * 1000);
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const iso = dmy[4]
      ? `${dmy[3]}-${dmy[2]}-${dmy[1]}T${dmy[4]}:${dmy[5]}:${dmy[6] ?? "00"}`
      : `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.getTime();
}

function parseFracht(s: string): { amount: number; currency: string } {
  if (!s) return { amount: 0, currency: "EUR" };
  const str = String(s).replace(/\s/g, "");
  const m = str.match(/([\d,.]+)([A-Z]{3})/);
  if (!m) return { amount: 0, currency: "EUR" };
  const num = parseFloat(m[1].replace(",", "."));
  return { amount: isNaN(num) ? 0 : num, currency: m[2] };
}

function orsStatusColor(s?: OrsVerification["status"]) {
  if (!s) return "";
  return { ok: "text-emerald-600", warn: "text-amber-600", alert: "text-red-600", error: "text-slate-400" }[s];
}

function DiffBadge({ pct }: { pct: number }) {
  const abs = Math.abs(pct);
  const cls = abs < 10
    ? "bg-emerald-50 text-emerald-700"
    : abs < 25
    ? "bg-amber-50 text-amber-700"
    : "bg-red-50 text-red-700";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-mono ${cls}`}>
      {pct > 0 ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

export default function AnalizaPage() {
  const { settings } = useSettings();
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<RouteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [eurRate, setEurRate] = useState(4.27);
  const [fuelPrice, setFuelPrice] = useState(1.25);
  const [sortKey, setSortKey] = useState<keyof RouteRow>("marginPct");
  const [sortDesc, setSortDesc] = useState(false);

  // Sync fuel price and EUR rate from settings when they load from Supabase
  useEffect(() => {
    if (settings.fuelPriceEurL) setFuelPrice(settings.fuelPriceEurL);
    if (settings.plnEurRate)    setEurRate(settings.plnEurRate);
  }, [settings.fuelPriceEurL, settings.plnEurRate]);

  // ORS verification state
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState({ done: 0, total: 0 });
  const [showOrsColumns, setShowOrsColumns] = useState(false);
  const [hideEstimated, setHideEstimated] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setFilename(file.name);
    setLoading(true);
    setRows([]);
    setError(null);
    setDebug(null);
    setShowOrsColumns(false);

    try {
      const { data: vehicles, error: dbErr } = await supabase
        .from("vehicles")
        .select("reg, vehicle_type, dispatcher_id, avg_fuel_l100, year_produced, leasing_eur_mo, insurance_eur_mo, service_cost_km, service_contract, avg_km_month");

      if (dbErr) setDebug(`DB warning: ${dbErr.message}`);

      const fuelMap:          Record<string, number> = {};
      const yearMap:          Record<string, number> = {};
      const leasingMap:       Record<string, number> = {};
      const insuranceMap:     Record<string, number> = {};
      const serviceMap:       Record<string, number> = {};
      const serviceContractSet: Set<string> = new Set();
      const kmMonthMap:       Record<string, number> = {};
      // naczepa_reg → leasing EUR/mo (direct lookup from TMS naczepa column)
      const trailerLeasingMap: Record<string, number> = {};

      for (const v of vehicles ?? []) {
        if (!v.reg) continue;
        if (v.avg_fuel_l100)    fuelMap[v.reg]      = Number(v.avg_fuel_l100);
        if (v.year_produced)    yearMap[v.reg]      = Number(v.year_produced);
        if (v.leasing_eur_mo)   leasingMap[v.reg]   = Number(v.leasing_eur_mo);
        if (v.insurance_eur_mo) insuranceMap[v.reg] = Number(v.insurance_eur_mo);
        if (v.service_cost_km)  serviceMap[v.reg]   = Number(v.service_cost_km);
        if (v.service_contract) serviceContractSet.add(v.reg);
        if (v.avg_km_month)     kmMonthMap[v.reg]   = Number(v.avg_km_month);
        if (v.vehicle_type === "naczepa" && v.leasing_eur_mo)
          trailerLeasingMap[v.reg] = Number(v.leasing_eur_mo);
      }

      // Fleet average naczepa leasing — fallback when naczepa not found in vehicles table
      const allTrailerLeasings = Object.values(trailerLeasingMap);
      const fleetAvgTrailerLeasing = allTrailerLeasings.length
        ? allTrailerLeasings.reduce((a, b) => a + b, 0) / allTrailerLeasings.length
        : undefined; // falls back to FLEET tier constants in calculator

      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const all = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as string[][];

      let hIdx = 0;
      for (let i = 0; i < Math.min(5, all.length); i++) {
        const joined = all[i].join("|").toLowerCase();
        if (joined.includes("nr") && joined.includes("kraj")) { hIdx = i; break; }
      }

      const headers = all[hIdx].map(h => String(h).trim());
      const dataRows = all.slice(hIdx + 1).filter(r => r.some(c => String(c).trim() !== ""));

      setDebug(`Znaleziono ${dataRows.length} wierszy, nagłówek: wiersz ${hIdx}. Kolumny: ${headers.filter(h=>h).slice(0,8).join(", ")}…`);

      function get(row: string[], ...keys: string[]): string {
        for (const key of keys) {
          const idx = headers.findIndex(h => h.toLowerCase().includes(key.toLowerCase()));
          if (idx >= 0 && row[idx] != null && String(row[idx]).trim() !== "")
            return String(row[idx]).trim();
        }
        return "";
      }

      // ── Pre-pass: buduj mapę ciągnik+data → łączna liczba km w danym dniu ──
      // Używane do proporcjonalnego podziału kosztów dniowych (kierowca/leasing/ubezp.)
      // gdy ten sam ciągnik realizuje >1 zlecenie tego samego dnia.
      const dayGroupTotalKm = new Map<string, number>();
      for (const row of dataRows) {
        const oNr = get(row, "Nr pełny", "Nr pe", "Nr ");
        if (!oNr) continue;
        const dKmOdo = parseFloat(get(row, "lad. wg licznika") || "0");
        const dKmMap = parseFloat(get(row, "km ład", "km wg", "Km") || "0");
        const dKm = dKmOdo > 0 ? dKmOdo : dKmMap;
        if (dKm < 10) continue;
        const veh = get(row, "ciągnik", "ciagnik", "pojazd").toUpperCase();
        // Pre-pass: używaj actual pickup date (tak samo jak main-loop) żeby perDobeShareFactor zgadzał się
        const pickupR = get(row, "podjęcie rzeczywiste", "podjecie rzeczywiste", "podjęcie", "podjecie", "data załadunku", "załadunek");
        const tDate = toDateKey(pickupR);
        if (veh && tDate) {
          const k = `${veh}|${tDate}`;
          dayGroupTotalKm.set(k, (dayGroupTotalKm.get(k) ?? 0) + dKm);
        }
      }

      const computed: RouteRow[] = dataRows
        .map((row): RouteRow | null => {
          const orderNr = get(row, "Nr pełny", "Nr pe", "Nr ");
          if (!orderNr) return null;

          // Preferuj km wg licznika (odometr) — rzeczywiste km; fallback km wg mapy
          // Spójnie z dyspozytorzy/page.tsx (Task #16 + #22)
          const kmLadOdo  = parseFloat(get(row, "lad. wg licznika") || "0");
          const kmLadMapa = parseFloat(get(row, "km ład", "km wg", "Km") || "0");
          const distanceKm = kmLadOdo > 0 ? kmLadOdo : kmLadMapa;
          if (distanceKm < 10) return null;

          // Empty/deadhead km — added to cost base (fuel + service) but not revenue
          // Preferuj odometr (gdy licznikowe ładowne), fallback mapowe puste
          const kmPusteOdo  = parseFloat(get(row, "puste wg licznika") || "0");
          const kmPusteMapa = parseFloat(get(row, "puste km", "km puste", "km pusty", "km empty") || "0");
          const emptyKmRaw = kmLadOdo > 0
            ? (kmPusteOdo > 0 ? kmPusteOdo : kmPusteMapa)
            : kmPusteMapa;
          const emptyKm = emptyKmRaw > 0 ? emptyKmRaw : undefined;

          const frachtRaw = get(row, "fracht z wal", "fracht");
          const { amount: frachtAmount, currency } = parseFracht(frachtRaw);
          let frachtEur = currency === "PLN" ? frachtAmount / eurRate : frachtAmount;
          // Niektóre trasy mają "Stawka końcowa Xeuro" w Wymaganiach — override frachtu
          const wymagania = get(row, "wymagania");
          const stawkaMatch = wymagania.match(/stawka\s+ko[ńn]cowa\s+([\d\s,.]+)\s*[€eE]/i);
          if (stawkaMatch) {
            const finalRate = parseFloat(stawkaMatch[1].replace(/[\s]/g, "").replace(",", "."));
            if (!isNaN(finalRate) && finalRate > frachtEur) frachtEur = finalRate;
          }

          const vehicle       = get(row, "ciągnik", "ciagnik", "pojazd").toUpperCase();
          const naczepaReg    = get(row, "naczepa", "naczepa:", "naczepa ").toUpperCase();
          const originCountry = get(row, "zał. kraj", "zal. kraj", "kraj za").toUpperCase() || "PL";
          const destCountry = get(row, "roz. kraj", "kraj ro").toUpperCase() || "PL";
          const originCity = get(row, "zał. miasto", "zal. miasto");
          const destCity   = get(row, "roz. miasto");

          const avgFuelL100           = fuelMap[vehicle]      ?? FLEET.avgFuelL100;
          const vehicleYear           = yearMap[vehicle];
          const leasingEurMo          = leasingMap[vehicle];
          const insuranceEurMo        = insuranceMap[vehicle];
          const serviceCostKmOverride = serviceMap[vehicle];
          const serviceContract       = serviceContractSet.has(vehicle);
          // Trailer leasing: (1) exact naczepa from TMS, (2) fleet avg naczep, (3) tier in calculator
          const trailerLeasingEurMo   = (naczepaReg && trailerLeasingMap[naczepaReg])
            ? trailerLeasingMap[naczepaReg]
            : fleetAvgTrailerLeasing;

          // Route days from TMS dates — prefer "rzeczywiste" (actual) over planned
          // Columns: "Podjęcie rzeczywiste" / "Podjęcie" for pickup
          //          "Dostarczenie rzeczywiste" / "Dostarczenie" for delivery
          const pickupRaw   = get(row, "podjęcie rzeczywiste", "podjecie rzeczywiste", "podjęcie", "podjecie", "data załadunku", "załadunek");
          const deliveryRaw = get(row, "dostarczenie rzeczywiste", "dostarczenie rzeczyw", "dostarczenie", "data rozładunku", "rozładunek");
          const tripDate    = toDateKey(pickupRaw);
          // Route duration — ułamkowe dni na podstawie rzeczywistych timestamp-ów
          let routeDays: number | undefined;
          const pickupTs   = toTimestamp(pickupRaw);
          const deliveryTs = toTimestamp(deliveryRaw);
          const totalKm    = distanceKm + (emptyKmRaw > 0 ? emptyKmRaw : 0);
          const maxReasonableDays = Math.max(2, Math.ceil((totalKm || 500) / 150));
          if (pickupTs !== undefined && deliveryTs !== undefined && deliveryTs > pickupTs) {
            const durationDays = (deliveryTs - pickupTs) / 86400000;
            routeDays = durationDays <= maxReasonableDays
              ? Math.round(durationDays * 100) / 100
              : undefined;
          } else if (pickupRaw && deliveryRaw) {
            // Fallback: całkowite dni gdy brak dokładnych timestamp-ów
            const d1 = new Date(toDateKey(pickupRaw));
            const d2 = new Date(toDateKey(deliveryRaw));
            if (!isNaN(d1.getTime()) && !isNaN(d2.getTime()) && d2 >= d1) {
              const rawDays = Math.max(1, Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1);
              routeDays = rawDays <= maxReasonableDays ? rawDays : undefined;
            }
          }

          // Kontynuacja trasy — ten sam ciągnik, ten sam dzień → dziel koszty dzienne proporcjonalnie
          const dayKey = vehicle && tripDate ? `${vehicle}|${tripDate}` : "";
          const totalKmDay = dayKey ? (dayGroupTotalKm.get(dayKey) ?? distanceKm) : distanceKm;
          const perDobeShareFactor = totalKmDay > distanceKm
            ? Math.round((distanceKm / totalKmDay) * 10000) / 10000
            : 1.0;
          const isContinuation = perDobeShareFactor < 1.0;

          // TMS own margin/km — "Marża EUR na 1 KM z mapy"
          const tmsMarzaPerKmRaw = parseFloat(get(row, "marża eur na 1 km", "marża eur") || "0");
          const tmsMarzaPerKm = isNaN(tmsMarzaPerKmRaw) ? 0 : tmsMarzaPerKmRaw;

          // Real toll from TMS (DKV/viaTOLL actual invoices)
          // Szukamy po różnych możliwych nazwach kolumn eksportu TMS
          const tmsTollEurRaw = parseFloat(get(row,
            "myto na trasie eur", "myto eur", "maut eur", "toll eur", "opłata drogowa eur"
          ) || "0");
          const tmsTollPlnRaw = parseFloat(get(row,
            "myto na trasie pln", "myto pln", "maut pln", "toll pln",
            "opłata drogowa pln", "opłata drogowa"
          ) || "0");
          const tmsTollEur = tmsTollEurRaw > 0
            ? tmsTollEurRaw
            : tmsTollPlnRaw > 0
            ? Math.round((tmsTollPlnRaw / eurRate) * 100) / 100
            : 0;

          // Estimate fracht when TMS has no invoice yet (fracht=0)
          let frachtEstimated = false;
          let noFreightData = false;
          if (frachtEur === 0 && tmsMarzaPerKm > 0) {
            const breakdown0 = calculateRoute({
              originCountry, destCountry, distanceKm, emptyKm,
              fuelPriceEurL: fuelPrice, freightEur: 1,
              transitCountries: [originCountry, destCountry],
              avgFuelL100, vehicleYearProduced: vehicleYear, leasingEurMo,
              trailerLeasingEurMo,
              insuranceEurMo, serviceCostKmOverride, serviceContract, routeDays,
              overrideTollEur: tmsTollEur || undefined,
              perDobeShareFactor,
            }, settings);
            frachtEur = Math.round((breakdown0.total + tmsMarzaPerKm * distanceKm) * 100) / 100;
            frachtEstimated = true;
          } else if (frachtEur === 0) {
            // No invoice AND no TMS margin hint — show as BRAK DANYCH (costs visible, revenue unknown)
            noFreightData = true;
          }

          const breakdown = calculateRoute({
            originCountry, destCountry, distanceKm, emptyKm,
            fuelPriceEurL: fuelPrice,
            freightEur: frachtEur,
            transitCountries: [originCountry, destCountry],
            avgFuelL100, vehicleYearProduced: vehicleYear, leasingEurMo,
            trailerLeasingEurMo,
            insuranceEurMo, serviceCostKmOverride, serviceContract, routeDays,
            overrideTollEur: tmsTollEur || undefined,
            perDobeShareFactor,
          }, settings);

          const { label, color } = noFreightData
            ? { label: "BRAK DANYCH", color: "slate" }
            : profitabilityLabel(breakdown.marginPct, settings.marginGoodPct, settings.marginLowPct);

          return {
            orderNr,
            client: get(row, "zleceniodawca", "klient"),
            vehicle: vehicle || "—",
            originCountry, destCountry, originCity, destCity,
            distanceKm, emptyKm, totalKm,
            frachtRaw,
            frachtEur: Math.round(frachtEur * 100) / 100,
            frachtEstimated, noFreightData,
            currency, avgFuelL100, tmsMarzaPerKm,
            marginEur: breakdown.marginEur,
            marginPct: breakdown.marginPct,
            costPerKm: breakdown.costPerKm,
            revenuePerKm: breakdown.revenuePerKm,
            totalCost: breakdown.total,
            tollCost: breakdown.toll,
            tollFromTms: tmsTollEur > 0,
            label, labelColor: color,
            euroClass: vehicleYear ? deriveEuroClass(vehicleYear) : 6,
            isContinuation, perDobeShareFactor, tripDate,
          };
        })
        .filter((r): r is RouteRow => r !== null);

      setRows(computed);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // ─── ORS batch verification ──────────────────────────────────
  async function handleVerifyOrs() {
    const routesToVerify = rows.filter(r => r.originCity && r.destCity);
    if (routesToVerify.length === 0) {
      alert("Brak tras z miastami — upewnij się że plik zawiera kolumny miast.");
      return;
    }

    setVerifying(true);
    setVerifyProgress({ done: 0, total: routesToVerify.length });
    setShowOrsColumns(true);

    const updatedRows = [...rows];

    for (let i = 0; i < updatedRows.length; i++) {
      const row = updatedRows[i];
      if (!row.originCity || !row.destCity) continue;

      try {
        const res = await fetch("/api/route-quick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: row.originCity,
            to: row.destCity,
            originCountry: row.originCountry,
            destCountry: row.destCountry,
          }),
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          updatedRows[i] = {
            ...row,
            ors: { distanceKm: 0, tollEur: 0, durationH: 0, diffKm: 0, diffKmPct: 0, status: "error", error: data.error },
          };
        } else {
          const diffKm    = Math.round((data.distanceKm - row.distanceKm) * 10) / 10;
          const diffKmPct = Math.round((diffKm / row.distanceKm) * 1000) / 10;
          const absP      = Math.abs(diffKmPct);
          const status: OrsVerification["status"] = absP < 10 ? "ok" : absP < 25 ? "warn" : "alert";

          updatedRows[i] = {
            ...row,
            ors: { distanceKm: data.distanceKm, tollEur: data.tollEur, durationH: data.durationH, diffKm, diffKmPct, status },
          };
        }
      } catch (e) {
        updatedRows[i] = {
          ...row,
          ors: { distanceKm: 0, tollEur: 0, durationH: 0, diffKm: 0, diffKmPct: 0, status: "error", error: String(e) },
        };
      }

      setRows([...updatedRows]);
      setVerifyProgress({ done: i + 1, total: routesToVerify.length });

      // Rate limit: route-quick makes 2 sequential Nominatim calls (1.1s each)
      // Wait 500ms extra after the API response to stay safely under 1 req/sec
      await new Promise(r => setTimeout(r, 500));
    }

    setVerifying(false);
  }

  function toggleSort(key: keyof RouteRow) {
    if (sortKey === key) setSortDesc(!sortDesc);
    else { setSortKey(key); setSortDesc(key === "marginPct" ? false : true); }
  }

  const SortIcon = ({ k }: { k: keyof RouteRow }) =>
    sortKey === k ? <span className="ml-1">{sortDesc ? "↓" : "↑"}</span> : null;

  const estimatedCount  = rows.filter(r => r.frachtEstimated).length;
  const noFreightCount  = rows.filter(r => r.noFreightData).length;
  // displayRows — tylko do wyświetlania tabeli (toggle ukryj szacowane)
  const displayRows     = hideEstimated ? rows.filter(r => !r.frachtEstimated) : rows;

  const sorted = [...displayRows].sort((a, b) => {
    const av = a[sortKey]; const bv = b[sortKey];
    if (typeof av === "number" && typeof bv === "number")
      return sortDesc ? bv - av : av - bv;
    return String(av).localeCompare(String(bv));
  });

  // KPI totals ZAWSZE na podstawie WSZYSTKICH tras (rows) — spójnie z Dyspozytorzy
  // displayRows służy tylko do filtrowania tabeli, nie wpływa na sumy
  const allRows = rows;
  const profitable  = allRows.filter(r => r.marginPct >= 15  && !r.noFreightData).length;
  const lowMargin   = allRows.filter(r => r.marginPct >= 5   && r.marginPct < 15 && !r.noFreightData).length;
  const breakeven   = allRows.filter(r => r.marginPct >= 0   && r.marginPct < 5  && !r.noFreightData).length;
  const losses      = allRows.filter(r => r.marginPct < 0    && !r.noFreightData).length;
  const totalFreight = allRows.reduce((s, r) => s + r.frachtEur, 0);
  const totalCosts   = allRows.reduce((s, r) => s + r.totalCost, 0);
  const totalMargin  = totalFreight - totalCosts;
  const avgMargin    = allRows.length > 0
    ? Math.round(allRows.reduce((s, r) => s + r.marginPct, 0) / allRows.length * 10) / 10 : 0;

  // ORS stats (tylko zweryfikowane trasy)
  const verified       = displayRows.filter(r => r.ors && r.ors.status !== "error");
  const alertCount     = verified.filter(r => r.ors!.status === "alert").length;
  const warnCount      = verified.filter(r => r.ors!.status === "warn").length;
  const totalKmTms     = verified.reduce((s, r) => s + r.totalKm, 0);
  const totalKmOrs     = verified.reduce((s, r) => s + (r.ors?.distanceKm ?? 0), 0);
  const kmFleetDiff    = totalKmOrs - totalKmTms;

  const colorMap: Record<string, string> = {
    emerald: "bg-emerald-100 text-emerald-800",
    amber:   "bg-amber-100 text-amber-800",
    orange:  "bg-orange-100 text-orange-800",
    red:     "bg-red-100 text-red-800",
    slate:   "bg-slate-100 text-slate-600",
  };
  const borderMap: Record<string, string> = {
    emerald: "border-l-4 border-emerald-400",
    amber:   "border-l-4 border-amber-400",
    orange:  "border-l-4 border-orange-400",
    red:     "border-l-4 border-red-400",
    slate:   "border-l-4 border-slate-300",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Analiza rentowności tras</h1>
          <p className="text-sm text-slate-500 mt-1">
            Kalkulator kosztów · Weryfikacja km i myto przez ORS HGV
          </p>
        </div>
      </div>

      {/* Settings + Upload */}
      <div className="card">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="label">Cena paliwa (EUR/l)</label>
            <input type="number" step="0.01" min="0.8" max="2.5"
              value={fuelPrice} onChange={e => setFuelPrice(parseFloat(e.target.value) || 1.25)}
              className="input-field" />
          </div>
          <div>
            <label className="label">Kurs PLN/EUR</label>
            <input type="number" step="0.01" min="3.5" max="5.0"
              value={eurRate} onChange={e => setEurRate(parseFloat(e.target.value) || 4.27)}
              className="input-field" />
          </div>
          <div className="flex flex-col justify-end">
            <label className="label">Plik z trasami (XLS/XLSX)</label>
            <input ref={fileRef} type="file" accept=".xls,.xlsx"
              onChange={handleFile} disabled={loading}
              className="block w-full text-sm text-slate-500
                file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0
                file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700
                hover:file:bg-blue-100 cursor-pointer" />
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-blue-600 text-sm">
            <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            Analizuję {filename}…
          </div>
        )}
        {error && (
          <div className="mt-3 p-3 bg-red-50 rounded-lg text-red-700 text-sm">
            <strong>Błąd:</strong> {error}
          </div>
        )}
        {debug && (
          <div className="mt-3 p-3 bg-slate-50 rounded-lg text-slate-500 text-xs font-mono">
            {debug}
          </div>
        )}
      </div>

      {/* ORS verification button */}
      {rows.length > 0 && (
        <div className="flex items-center gap-4 flex-wrap">
          {!verifying ? (
            <button
              onClick={handleVerifyOrs}
              disabled={verifying}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              <span>🛣️</span>
              {verified.length > 0
                ? `Odśwież weryfikację ORS (${verified.length}/${rows.length})`
                : `Zweryfikuj trasy przez ORS HGV (${rows.filter(r => r.originCity && r.destCity).length} tras)`}
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
              <div className="flex-1 min-w-[200px]">
                <div className="flex justify-between text-xs text-slate-600 mb-1">
                  <span>Weryfikacja ORS… {verifyProgress.done}/{verifyProgress.total}</span>
                  <span>{Math.round((verifyProgress.done / verifyProgress.total) * 100)}%</span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-1.5">
                  <div
                    className="bg-blue-600 h-1.5 rounded-full transition-all"
                    style={{ width: `${(verifyProgress.done / verifyProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          )}
          {verified.length > 0 && (
            <button
              onClick={() => setShowOrsColumns(v => !v)}
              className="text-sm text-blue-600 hover:text-blue-800 underline"
            >
              {showOrsColumns ? "Ukryj kolumny ORS" : "Pokaż kolumny ORS"}
            </button>
          )}
        </div>
      )}

      {/* Estimated freight banner */}
      {estimatedCount > 0 && (
        <div className="flex items-center justify-between gap-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
          <div className="flex items-center gap-2">
            <span className="text-amber-600 font-bold">⚠️</span>
            <span className="text-amber-800">
              <strong>{estimatedCount} tras</strong> bez faktury w TMS — fracht szacowany z marży TMS (koszt HBM + marża TMS/km).
              {noFreightCount > 0 && <span className="ml-2 text-amber-600">+{noFreightCount} z zerowym frachtem — brak faktury i marży TMS (widoczne jako BRAK DANYCH).</span>}
            </span>
          </div>
          <button
            onClick={() => setHideEstimated(v => !v)}
            className="shrink-0 text-xs px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-800 font-semibold rounded-lg transition-colors"
          >
            {hideEstimated ? `Pokaż szacowane (${estimatedCount})` : `Ukryj szacowane (${estimatedCount})`}
          </button>
        </div>
      )}

      {/* ORS summary */}
      {verified.length > 0 && showOrsColumns && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="card">
            <p className="text-xs text-slate-500 uppercase tracking-wide">Zweryfikowano</p>
            <p className="text-2xl font-bold text-slate-800 mt-1">{verified.length}/{rows.length}</p>
          </div>
          <div className={`card border ${alertCount > 0 ? "border-red-200 bg-red-50" : ""}`}>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Anomalie &gt;25% km</p>
            <p className={`text-2xl font-bold mt-1 ${alertCount > 0 ? "text-red-600" : "text-slate-800"}`}>
              {alertCount}
            </p>
          </div>
          <div className={`card border ${warnCount > 0 ? "border-amber-200 bg-amber-50" : ""}`}>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Ostrzeżenia 10–25%</p>
            <p className={`text-2xl font-bold mt-1 ${warnCount > 0 ? "text-amber-600" : "text-slate-800"}`}>
              {warnCount}
            </p>
          </div>
          <div className={`card border ${Math.abs(kmFleetDiff) > 1000 ? "border-amber-200 bg-amber-50" : ""}`}>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Δ km łącznie (ORS−TMS)</p>
            <p className={`text-2xl font-bold mt-1 ${kmFleetDiff > 500 ? "text-amber-600" : kmFleetDiff < -500 ? "text-blue-600" : "text-emerald-600"}`}>
              {kmFleetDiff > 0 ? "+" : ""}{kmFleetDiff.toLocaleString("pl-PL", { maximumFractionDigits: 0 })} km
            </p>
            <p className="text-xs text-slate-400">
              TMS: {totalKmTms.toLocaleString("pl-PL", {maximumFractionDigits:0})} · ORS: {totalKmOrs.toLocaleString("pl-PL", {maximumFractionDigits:0})}
            </p>
          </div>
        </div>
      )}

      {/* KPI */}
      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="card border-l-4 border-emerald-500">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Rentowne ≥15%</p>
              <p className="text-3xl font-bold text-emerald-600 mt-1">{profitable}</p>
            </div>
            <div className="card border-l-4 border-amber-500">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Niska marża 5–15%</p>
              <p className="text-3xl font-bold text-amber-600 mt-1">{lowMargin}</p>
            </div>
            <div className="card border-l-4 border-orange-500">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Próg 0–5%</p>
              <p className="text-3xl font-bold text-orange-600 mt-1">{breakeven}</p>
            </div>
            <div className="card border-l-4 border-red-500">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Strata</p>
              <p className="text-3xl font-bold text-red-600 mt-1">{losses}</p>
            </div>
            {noFreightCount > 0 && (
              <div className="card border-l-4 border-slate-300">
                <p className="text-xs text-slate-500 uppercase tracking-wide">Brak danych</p>
                <p className="text-3xl font-bold text-slate-500 mt-1">{noFreightCount}</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="card">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Tras</p>
              <p className="text-3xl font-bold text-slate-800 mt-1">{rows.length}</p>
            </div>
            <div className="card">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Łączny fracht</p>
              <p className="text-2xl font-bold text-slate-800 mt-1">
                {totalFreight.toLocaleString("pl-PL", { maximumFractionDigits: 0 })} EUR
              </p>
            </div>
            <div className="card">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Łączne koszty</p>
              <p className="text-2xl font-bold text-slate-800 mt-1">
                {totalCosts.toLocaleString("pl-PL", { maximumFractionDigits: 0 })} EUR
              </p>
            </div>
            <div className={`card ${totalMargin >= 0 ? "border-l-4 border-emerald-500" : "border-l-4 border-red-500"}`}>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Łączna marża</p>
              <p className={`text-2xl font-bold mt-1 ${totalMargin >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                {totalMargin.toLocaleString("pl-PL", { maximumFractionDigits: 0 })} EUR
              </p>
              <p className="text-xs text-slate-400">{avgMargin}% średnio</p>
            </div>
          </div>

          {/* Table */}
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 uppercase">Zlecenie</th>
                  <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 uppercase">Trasa</th>
                  <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 uppercase">Pojazd</th>
                  <th className="text-right px-3 py-3 text-xs font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-800"
                    onClick={() => toggleSort("distanceKm")}>
                    Km TMS <SortIcon k="distanceKm" />
                  </th>
                  {showOrsColumns && (
                    <>
                      <th className="text-right px-3 py-3 text-xs font-semibold text-blue-500 uppercase bg-blue-50/50">Km ORS</th>
                      <th className="text-center px-3 py-3 text-xs font-semibold text-blue-500 uppercase bg-blue-50/50">Δ km</th>
                    </>
                  )}
                  <th className="text-right px-3 py-3 text-xs font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-800"
                    onClick={() => toggleSort("frachtEur")}>Fracht EUR <SortIcon k="frachtEur" /></th>
                  <th className="text-right px-3 py-3 text-xs font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-800"
                    onClick={() => toggleSort("tollCost")} title="Myto wg macierzy stawek + klasy EURO pojazdu">Myto EUR <SortIcon k="tollCost" /></th>
                  <th className="text-right px-3 py-3 text-xs font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-800"
                    onClick={() => toggleSort("totalCost")}>Koszty EUR <SortIcon k="totalCost" /></th>
                  <th className="text-right px-3 py-3 text-xs font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-800"
                    onClick={() => toggleSort("marginPct")}>Marża % <SortIcon k="marginPct" /></th>
                  <th className="text-center px-3 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sorted.map(r => (
                  <tr key={r.orderNr}
                    className={`hover:bg-slate-50 ${borderMap[r.labelColor] ?? ""}
                      ${r.ors?.status === "alert" ? "bg-red-50/30" : r.ors?.status === "warn" ? "bg-amber-50/20" : ""}`}>
                    <td className="px-3 py-2.5">
                      <div className="font-mono text-xs text-slate-700">{r.orderNr}</div>
                      <div className="text-xs text-slate-400 truncate max-w-[130px]">{r.client}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-slate-800">{r.originCountry} → {r.destCountry}</div>
                      <div className="text-xs text-slate-400 truncate max-w-[160px]">{r.originCity} → {r.destCity}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-mono text-xs text-slate-700 flex items-center gap-1">
                        {r.vehicle}
                        <span
                          className={`inline-block px-1 py-0 rounded text-[10px] font-bold
                            ${r.euroClass >= 6 ? "bg-emerald-100 text-emerald-700"
                            : r.euroClass === 5 ? "bg-amber-100 text-amber-700"
                            : "bg-red-100 text-red-700"}`}
                          title={`EURO ${r.euroClass} — wpływa na stawkę myto DE/AT/CH`}
                        >
                          E{r.euroClass}
                        </span>
                      </div>
                      {r.isContinuation && (
                        <div className="mt-0.5 flex items-center gap-1">
                          <span
                            className="inline-block px-1.5 py-0 rounded text-[10px] font-bold bg-violet-100 text-violet-700"
                            title={`Kontynuacja: ciągnik ma kilka zleceń tego dnia. Udział w dniówce: ${(r.perDobeShareFactor * 100).toFixed(1)}% (proporcja km)`}
                          >
                            KONT. {(r.perDobeShareFactor * 100).toFixed(0)}%
                          </span>
                        </div>
                      )}
                      <div className="text-xs text-slate-400">{r.avgFuelL100} l/100</div>
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-600">
                      {r.totalKm.toLocaleString("pl-PL", { maximumFractionDigits: 0 })}
                    </td>
                    {showOrsColumns && (
                      <>
                        <td className="px-3 py-2.5 text-right bg-blue-50/30">
                          {r.ors ? (
                            r.ors.status === "error"
                              ? <span className="text-slate-300 text-xs" title={r.ors.error}>—</span>
                              : <span className={`font-medium ${orsStatusColor(r.ors.status)}`}>
                                  {r.ors.distanceKm.toLocaleString("pl-PL", { maximumFractionDigits: 0 })}
                                </span>
                          ) : (
                            verifying
                              ? <span className="inline-block w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
                              : <span className="text-slate-300 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center bg-blue-50/30">
                          {r.ors && r.ors.status !== "error" && (
                            <DiffBadge pct={r.ors.diffKmPct} />
                          )}
                        </td>
                      </>
                    )}
                    <td className="px-3 py-2.5 text-right font-semibold text-slate-800">
                      {r.noFreightData
                        ? <span className="text-slate-400 italic text-xs font-normal">brak faktury</span>
                        : r.frachtEur.toLocaleString("pl-PL", { maximumFractionDigits: 0 })}
                      {r.frachtEstimated && (
                        <div className="text-xs text-amber-500 font-normal" title={`Szacowany: koszt HBM + marża TMS ${r.tmsMarzaPerKm} EUR/km`}>
                          ~szacowany
                        </div>
                      )}
                      {r.currency === "PLN" && !r.frachtEstimated && !r.noFreightData && (
                        <div className="text-xs text-slate-400 font-normal">{r.frachtRaw}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-600"
                      title={r.tollFromTms
                        ? `Myto z TMS (DKV/viaTOLL): ${r.tollCost.toFixed(2)} EUR`
                        : `Brak kolumny myta w pliku — szacowane z macierzy HBM (EURO ${r.euroClass}, ${r.originCountry}→${r.destCountry}). Dodaj "Myto na trasie EUR" lub "Myto na trasie PLN" w eksporcie TMS.`}>
                      {r.tollCost.toLocaleString("pl-PL", { maximumFractionDigits: 0 })}
                      <div className={`text-xs font-medium ${r.tollFromTms ? "text-emerald-600" : "text-slate-400"}`}>
                        {r.tollFromTms ? "✓ TMS" : `≈ macierz`}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-600">
                      {r.totalCost.toLocaleString("pl-PL", { maximumFractionDigits: 0 })}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-bold text-lg ${
                      r.noFreightData ? "text-slate-400" :
                      r.marginPct >= 15 ? "text-emerald-600" :
                      r.marginPct >= 5  ? "text-amber-600"   :
                      r.marginPct >= 0  ? "text-orange-600"  : "text-red-600"}`}>
                      {r.noFreightData ? "—" : `${r.marginPct}%`}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${colorMap[r.labelColor] ?? ""}`}>
                        {r.label}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400 text-center">
            Spalanie z Trimble per pojazd · Kurs PLN/EUR: {eurRate} · Paliwo: {fuelPrice} EUR/l
            {verified.length > 0 && ` · ORS: ${verified.length} tras zweryfikowanych`}
          </p>
        </>
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="card text-center py-16">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-slate-600 font-medium">Wgraj plik z trasami aby zobaczyć analizę</p>
          <p className="text-sm text-slate-400 mt-1">
            Format: eksport TMS — kolumny Nr pełny, Km ład. wg. mapy, Fracht z walutą, Ciągnik, Kraj/Miasto zał./roz.
          </p>
          <p className="text-xs text-slate-400 mt-2">
            Po załadowaniu możesz uruchomić <strong>weryfikację ORS HGV</strong> — porówna km z TMS z rzeczywistą trasą ciężarówki
          </p>
        </div>
      )}
    </div>
  );
}