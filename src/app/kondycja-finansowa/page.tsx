"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useSettings } from "@/lib/settings-context";

// ══════════════════════════════════════════════════════════════
// Typy
// ══════════════════════════════════════════════════════════════
interface Vehicle {
  id: string;
  reg: string;
  brand: string | null;
  model: string | null;
  vehicle_type: string | null;
  year_produced: number | null;
  is_active: boolean;
  status_reason: string | null;
  leasing_eur_mo: number | null;
  leasing_brutto_eur_mo: number | null;
  leasing_end_date: string | null;
  buyout_eur: number | null;
  insurance_eur_mo: number | null;
}

interface RouteRow {
  client: string | null;
  origin_country: string | null;
  dest_country: string | null;
  distance_km: number | null;
  margin_eur_km: number | null;
  vehicle_reg: string | null;
  pickup_date: string | null;
}

interface CostInvoiceRow {
  typ_kosztu: string | null;
  sprzedawca: string | null;
  numer: string | null;
  brutto_pln: number | null;
  pozostalo_do_zaplaty_pln: number | null;
  status_splaty: string | null;
  data_wystawienia: string | null;
  termin_platnosci: string | null;
  pojazd_reg: string | null;
}

const fmtEur = (n: number) => `${Math.round(n).toLocaleString("pl-PL")} EUR`;
const fmtPln = (n: number) => `${Math.round(n).toLocaleString("pl-PL")} PLN`;
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function monthsBetween(a: Date, b: Date) {
  return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
}

async function fetchAll<T>(table: string, cols: string): Promise<T[]> {
  let all: T[] = [];
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data, error } = await supabase.from(table).select(cols).range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat((data ?? []) as T[]);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ══════════════════════════════════════════════════════════════
// Strona
// ══════════════════════════════════════════════════════════════
export default function KondycjaFinansowaPage() {
  const { settings } = useSettings();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [invoices, setInvoices] = useState<CostInvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [v, r, i] = await Promise.all([
        fetchAll<Vehicle>(
          "vehicles",
          "id,reg,brand,model,vehicle_type,year_produced,is_active,status_reason,leasing_eur_mo,leasing_brutto_eur_mo,leasing_end_date,buyout_eur,insurance_eur_mo"
        ),
        fetchAll<RouteRow>("route_history", "client,origin_country,dest_country,distance_km,margin_eur_km,vehicle_reg,pickup_date"),
        fetchAll<CostInvoiceRow>(
          "cost_invoices",
          "typ_kosztu,sprzedawca,numer,brutto_pln,pozostalo_do_zaplaty_pln,status_splaty,data_wystawienia,termin_platnosci,pojazd_reg"
        ),
      ]);
      setVehicles(v);
      setRoutes(r);
      setInvoices(i);
      setLoading(false);
    })();
  }, []);

  // ── 1. Flota i leasing ─────────────────────────────────────
  const fleet = useMemo(() => {
    const today = new Date();
    const inactive = vehicles.filter((v) => !v.is_active);
    const stillLeased = inactive
      .filter((v) => v.leasing_end_date && v.leasing_end_date > todayStr())
      .map((v) => {
        const monthly = v.leasing_brutto_eur_mo ?? v.leasing_eur_mo ?? 0;
        const months = monthsBetween(today, new Date(v.leasing_end_date as string));
        return { ...v, monthly, monthsRemaining: months, totalRemaining: monthly * months };
      })
      .sort((a, b) => b.totalRemaining - a.totalRemaining);
    const deadWeightMonthly = stillLeased.reduce((s, v) => s + v.monthly, 0);
    const deadWeightTotal = stillLeased.reduce((s, v) => s + v.totalRemaining, 0);
    const buyoutSum = stillLeased.reduce((s, v) => s + (v.buyout_eur ?? 0), 0);
    return { inactive, stillLeased, deadWeightMonthly, deadWeightTotal, buyoutSum };
  }, [vehicles]);

  // ── 2. Klienci ──────────────────────────────────────────────
  const clients = useMemo(() => {
    const byClient: Record<string, { margin: number; km: number; orders: number; months: Set<string> }> = {};
    const allMonths = new Set<string>();
    for (const r of routes) {
      if (!r.client || r.margin_eur_km == null || r.distance_km == null) continue;
      const key = r.client.trim().toUpperCase();
      const month = r.pickup_date ? r.pickup_date.slice(0, 7) : null;
      if (month) allMonths.add(month);
      const entry = (byClient[key] ??= { margin: 0, km: 0, orders: 0, months: new Set() });
      entry.margin += r.margin_eur_km * r.distance_km;
      entry.km += r.distance_km;
      entry.orders += 1;
      if (month) entry.months.add(month);
    }
    const totalMonths = allMonths.size || 1;
    const ranked = Object.entries(byClient)
      .map(([name, v]) => ({
        name,
        margin: v.margin,
        km: v.km,
        orders: v.orders,
        monthsPresent: v.months.size,
        presenceRatio: v.months.size / totalMonths,
        type: v.months.size / totalMonths >= 0.6 ? "stały" : v.months.size / totalMonths <= 0.15 ? "spot" : "nieregularny",
      }))
      .sort((a, b) => b.margin - a.margin);
    const totalMargin = ranked.reduce((s, c) => s + c.margin, 0);
    const top3 = ranked.slice(0, 3);
    const top3Share = totalMargin > 0 ? (top3.reduce((s, c) => s + c.margin, 0) / totalMargin) * 100 : 0;
    // Kandydaci spot->stały: znaczący margines, ale nieregularna obecność
    const conversionCandidates = ranked
      .filter((c) => c.type !== "stały" && c.margin > 0)
      .slice(0, 8);
    return { ranked, totalMargin, top3, top3Share, totalMonths, conversionCandidates };
  }, [routes]);

  // ── 3. Trasy ────────────────────────────────────────────────
  const routeHealth = useMemo(() => {
    const byDirection: Record<string, { sumMargin: number; km: number; orders: number; negOrders: number }> = {};
    const byVehicle: Record<string, { sumMargin: number; km: number; orders: number; negOrders: number }> = {};
    for (const r of routes) {
      if (r.margin_eur_km == null || r.distance_km == null) continue;
      const dir = `${r.origin_country ?? "?"} → ${r.dest_country ?? "?"}`;
      const dEntry = (byDirection[dir] ??= { sumMargin: 0, km: 0, orders: 0, negOrders: 0 });
      dEntry.sumMargin += r.margin_eur_km * r.distance_km;
      dEntry.km += r.distance_km;
      dEntry.orders += 1;
      if (r.margin_eur_km < 0) dEntry.negOrders += 1;

      if (r.vehicle_reg) {
        const vEntry = (byVehicle[r.vehicle_reg] ??= { sumMargin: 0, km: 0, orders: 0, negOrders: 0 });
        vEntry.sumMargin += r.margin_eur_km * r.distance_km;
        vEntry.km += r.distance_km;
        vEntry.orders += 1;
        if (r.margin_eur_km < 0) vEntry.negOrders += 1;
      }
    }
    const worstDirections = Object.entries(byDirection)
      .filter(([, v]) => v.orders >= 5)
      .map(([dir, v]) => ({ dir, avgMarginKm: v.sumMargin / v.km, ...v }))
      .sort((a, b) => a.avgMarginKm - b.avgMarginKm)
      .slice(0, 8);
    const worstVehicles = Object.entries(byVehicle)
      .filter(([, v]) => v.orders >= 5)
      .map(([reg, v]) => ({ reg, avgMarginKm: v.sumMargin / v.km, ...v }))
      .sort((a, b) => a.avgMarginKm - b.avgMarginKm)
      .slice(0, 8);
    const lossMakingDirCount = Object.values(byDirection).filter((v) => v.sumMargin < 0).length;
    const totalLoss = Object.values(byDirection)
      .filter((v) => v.sumMargin < 0)
      .reduce((s, v) => s + v.sumMargin, 0);
    return { worstDirections, worstVehicles, lossMakingDirCount, totalLoss };
  }, [routes]);

  // ── 4. Płatności ────────────────────────────────────────────
  const payments = useMemo(() => {
    const outstanding = invoices.filter(
      (i) => i.status_splaty !== "Spłacony" && (i.pozostalo_do_zaplaty_pln ?? 0) > 0.01
    );
    const totalOutstanding = outstanding.reduce((s, i) => s + (i.pozostalo_do_zaplaty_pln ?? 0), 0);
    const byCategory: Record<string, number> = {};
    outstanding.forEach((i) => {
      const k = i.typ_kosztu ?? "Inne";
      byCategory[k] = (byCategory[k] ?? 0) + (i.pozostalo_do_zaplaty_pln ?? 0);
    });
    const categoryRanked = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

    const today = new Date();
    let overdue90 = 0;
    outstanding.forEach((i) => {
      if (!i.termin_platnosci) return;
      const days = Math.round((today.getTime() - new Date(i.termin_platnosci).getTime()) / 86400000);
      if (days > 90) overdue90 += i.pozostalo_do_zaplaty_pln ?? 0;
    });

    // Wykrywanie nietypowych "drugich serii" faktur leasingowych (kandydaci: odsetki/opłaty dodatkowe)
    // Numer w formacie N/MM/RRRR (dokładnie 3 segmenty), bez przypisanego pojazdu, powtarzalne u tego samego
    // dostawcy (≥3x) — WYMAGA POTWIERDZENIA, to wykrywanie wzorca, nie potwierdzony fakt księgowy.
    function isShortSeries(numer: string | null) {
      if (!numer) return false;
      const parts = numer.split("/");
      return parts.length === 3 && /^\d+$/.test(parts[0]) && /^\d{1,2}$/.test(parts[1]) && /^\d{4}$/.test(parts[2]);
    }
    const leasingRows = invoices.filter((i) => i.typ_kosztu === "Leasing");
    const byVendor: Record<string, CostInvoiceRow[]> = {};
    leasingRows.forEach((r) => {
      if (!r.sprzedawca) return;
      (byVendor[r.sprzedawca] ??= []).push(r);
    });
    const penaltyCandidates = Object.entries(byVendor)
      .map(([vendor, rows]) => {
        const series = rows.filter((r) => isShortSeries(r.numer) && !r.pojazd_reg);
        return { vendor, count: series.length, sum: series.reduce((s, r) => s + (r.brutto_pln ?? 0), 0), rows: series };
      })
      .filter((v) => v.count >= 3)
      .sort((a, b) => b.sum - a.sum);
    const penaltyTotal = penaltyCandidates.reduce((s, v) => s + v.sum, 0);

    return { totalOutstanding, categoryRanked, overdue90, penaltyCandidates, penaltyTotal };
  }, [invoices]);

  if (loading) {
    return <div className="p-8 text-sm text-slate-400">Ładowanie danych finansowych…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Kondycja finansowa</h1>
        <p className="text-slate-500 text-sm mt-1">
          Żywa diagnoza floty, klientów, tras i płatności — na bazie {routes.length.toLocaleString("pl-PL")} zleceń,{" "}
          {vehicles.length} pojazdów i {invoices.length.toLocaleString("pl-PL")} faktur kosztowych.
        </p>
      </div>

      {/* ── KPI banner ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiTile
          label="Leasing nieaktywnej floty"
          value={fmtEur(fleet.deadWeightMonthly)}
          sub={`${fleet.stillLeased.length} pojazdów / mies.`}
          tone="red"
        />
        <KpiTile
          label="Koncentracja top 3 klientów"
          value={fmtPct(clients.top3Share)}
          sub="udział w marży floty"
          tone={clients.top3Share > 60 ? "red" : clients.top3Share > 40 ? "amber" : "green"}
        />
        <KpiTile
          label="Kierunki ze stratą"
          value={String(routeHealth.lossMakingDirCount)}
          sub={routeHealth.lossMakingDirCount > 0 ? `łącznie ${fmtEur(Math.abs(routeHealth.totalLoss))}` : "brak strat kierunkowych"}
          tone={routeHealth.lossMakingDirCount > 0 ? "red" : "green"}
        />
        <KpiTile
          label="Zaległości płatnicze"
          value={fmtPln(payments.totalOutstanding)}
          sub={`w tym ${fmtPln(payments.overdue90)} >90 dni`}
          tone="amber"
        />
      </div>

      {/* ── 1. Flota i leasing ── */}
      <section className="card space-y-3">
        <h2 className="font-bold text-slate-800">🚛 Flota i leasing — koszt utrzymania nieaktywnych pojazdów</h2>
        <p className="text-sm text-slate-500">
          {fleet.inactive.length} nieaktywnych pojazdów, z czego {fleet.stillLeased.length} wciąż płaci leasing.
          Łącznie <strong>{fmtEur(fleet.deadWeightMonthly)}/mies.</strong> wypływa z kasy za pojazdy, które nie
          zarabiają — do końca obecnych umów to jeszcze <strong>{fmtEur(fleet.deadWeightTotal)}</strong>
          {fleet.buyoutSum > 0 && <> (plus {fmtEur(fleet.buyoutSum)} łącznego wykupu, jeśli chcecie zamknąć umowy wcześniej)</>}.
        </p>
        {fleet.stillLeased.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Pojazd</th>
                  <th className="pb-2 pr-3">Powód</th>
                  <th className="pb-2 pr-3 text-right">Leasing/mies.</th>
                  <th className="pb-2 pr-3 text-right">Koniec umowy</th>
                  <th className="pb-2 pr-3 text-right">Zostało mies.</th>
                  <th className="pb-2 pr-3 text-right">Suma do końca</th>
                </tr>
              </thead>
              <tbody>
                {fleet.stillLeased.map((v) => (
                  <tr key={v.id} className="border-b border-slate-100">
                    <td className="py-1.5 pr-3 font-medium">{v.reg} <span className="text-slate-400 font-normal">{v.brand} {v.model}</span></td>
                    <td className="py-1.5 pr-3 text-slate-500">{v.status_reason ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-right">{fmtEur(v.monthly)}</td>
                    <td className="py-1.5 pr-3 text-right">{v.leasing_end_date}</td>
                    <td className="py-1.5 pr-3 text-right">{v.monthsRemaining}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold text-red-600">{fmtEur(v.totalRemaining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 2. Klienci ── */}
      <section className="card space-y-3">
        <h2 className="font-bold text-slate-800">👥 Klienci — koncentracja i kandydaci do konwersji</h2>
        <p className="text-sm text-slate-500">
          {clients.ranked.length} klientów w {clients.totalMonths} mies. danych. Top 3 klientów odpowiada za{" "}
          <strong>{fmtPct(clients.top3Share)}</strong> całej marży floty — utrata jednego z nich to realne ryzyko
          płynności.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-bold text-slate-500 uppercase mb-2">Top 10 wg wkładu marżowego</h3>
            <table className="w-full text-sm">
              <tbody>
                {clients.ranked.slice(0, 10).map((c) => (
                  <tr key={c.name} className="border-b border-slate-100">
                    <td className="py-1 pr-2 truncate max-w-[180px]" title={c.name}>{c.name}</td>
                    <td className="py-1 pr-2 text-right font-medium">{fmtEur(c.margin)}</td>
                    <td className="py-1 text-right text-xs text-slate-400">{c.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="text-xs font-bold text-slate-500 uppercase mb-2">
              Kandydaci spot → stały (znaczący margines, nieregularna obecność)
            </h3>
            <table className="w-full text-sm">
              <tbody>
                {clients.conversionCandidates.map((c) => (
                  <tr key={c.name} className="border-b border-slate-100">
                    <td className="py-1 pr-2 truncate max-w-[160px]" title={c.name}>{c.name}</td>
                    <td className="py-1 pr-2 text-right">{fmtEur(c.margin)}</td>
                    <td className="py-1 text-right text-xs text-slate-400">{c.monthsPresent}/{clients.totalMonths} mies.</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── 3. Trasy ── */}
      <section className="card space-y-3">
        <h2 className="font-bold text-slate-800">🗺️ Trasy — rentowność kierunków i pojazdów</h2>
        {routeHealth.lossMakingDirCount > 0 ? (
          <p className="text-sm text-slate-500">
            {routeHealth.lossMakingDirCount} kierunków ma ujemną łączną marżę w analizowanym okresie, łącznie{" "}
            <strong className="text-red-600">{fmtEur(Math.abs(routeHealth.totalLoss))}</strong>. Poniżej najsłabsze
            kierunki i pojazdy (min. 5 zleceń, żeby odfiltrować przypadki jednorazowe).
          </p>
        ) : (
          <p className="text-sm text-slate-500">
            Żaden kierunek nie generuje obecnie ujemnej łącznej marży — dobra wiadomość. Poniżej i tak warto
            obserwować kierunki i pojazdy z <strong>najcieńszą</strong> marżą (min. 5 zleceń) — to kandydaci do
            renegocjacji stawek, zanim staną się realną stratą.
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-bold text-slate-500 uppercase mb-2">Najcieńsza marża — kierunki (EUR/km)</h3>
            <table className="w-full text-sm">
              <tbody>
                {routeHealth.worstDirections.map((d) => (
                  <tr key={d.dir} className="border-b border-slate-100">
                    <td className="py-1 pr-2">{d.dir}</td>
                    <td className={`py-1 pr-2 text-right font-medium ${d.avgMarginKm < 0 ? "text-red-600" : "text-slate-700"}`}>
                      {d.avgMarginKm.toFixed(2)} EUR/km
                    </td>
                    <td className="py-1 text-right text-xs text-slate-400">{d.orders} zleceń</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="text-xs font-bold text-slate-500 uppercase mb-2">Najcieńsza marża — pojazdy (EUR/km)</h3>
            <table className="w-full text-sm">
              <tbody>
                {routeHealth.worstVehicles.map((v) => (
                  <tr key={v.reg} className="border-b border-slate-100">
                    <td className="py-1 pr-2">{v.reg}</td>
                    <td className={`py-1 pr-2 text-right font-medium ${v.avgMarginKm < 0 ? "text-red-600" : "text-slate-700"}`}>
                      {v.avgMarginKm.toFixed(2)} EUR/km
                    </td>
                    <td className="py-1 text-right text-xs text-slate-400">{v.orders} zleceń</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── 4. Płatności ── */}
      <section className="card space-y-3">
        <h2 className="font-bold text-slate-800">💰 Płatności — struktura zobowiązań</h2>
        <p className="text-sm text-slate-500">
          Łącznie <strong>{fmtPln(payments.totalOutstanding)}</strong> zaległości płatniczych.
        </p>
        <table className="w-full text-sm max-w-md">
          <tbody>
            {payments.categoryRanked.slice(0, 8).map(([cat, sum]) => (
              <tr key={cat} className="border-b border-slate-100">
                <td className="py-1 pr-2">{cat}</td>
                <td className="py-1 text-right font-medium">{fmtPln(sum)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="border-t border-slate-200 pt-3">
          <h3 className="text-xs font-bold text-slate-500 uppercase mb-1">
            ⚠️ Kary i odsetki — wykryte automatycznie, wymaga potwierdzenia księgowości
          </h3>
          <p className="text-xs text-slate-500 mb-2">
            Szukamy w fakturach typu &quot;Leasing&quot; drugiej, nietypowej serii numeracji (bez przypisanego
            pojazdu, powtarzalnej u tego samego dostawcy) — to najczęściej sposób, w jaki leasingodawcy fakturują
            odsetki/opłaty dodatkowe osobno od rat. To wykrywanie wzorca, nie potwierdzony fakt księgowy — może
            zawierać fałszywe trafienia (np. osobny kontrakt na inny pojazd).
          </p>
          {payments.penaltyCandidates.length === 0 ? (
            <p className="text-sm text-slate-400">Nie wykryto takiego wzorca u żadnego dostawcy leasingowego.</p>
          ) : (
            <>
              <p className="text-sm mb-2">
                Suma kandydatów: <strong className="text-amber-600">{fmtPln(payments.penaltyTotal)}</strong>
              </p>
              <table className="w-full text-sm max-w-md">
                <tbody>
                  {payments.penaltyCandidates.map((v) => (
                    <tr key={v.vendor} className="border-b border-slate-100">
                      <td className="py-1 pr-2">{v.vendor}</td>
                      <td className="py-1 pr-2 text-right">{v.count} faktur</td>
                      <td className="py-1 text-right font-medium">{fmtPln(v.sum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </section>

      {/* ── 5. Rekomendacje ── */}
      <section className="card space-y-2 bg-slate-50">
        <h2 className="font-bold text-slate-800">✅ Rekomendacje</h2>
        <ul className="text-sm space-y-2 list-disc list-inside text-slate-700">
          {fleet.stillLeased.length > 0 && (
            <li>
              Rozważcie zamknięcie leasingu na {fleet.stillLeased.length} nieaktywnych pojazdach — to{" "}
              <strong>{fmtEur(fleet.deadWeightMonthly)}/mies.</strong> czystego kosztu bez przychodu (
              {fmtEur(fleet.deadWeightTotal)} do końca obecnych umów).
            </li>
          )}
          {clients.top3Share > 50 && (
            <li>
              {fmtPct(clients.top3Share)} marży zależy od 3 klientów — priorytet: dywersyfikacja portfela, w tym
              konwersja klientów z sekcji &quot;Kandydaci spot → stały&quot; na stałe kontrakty.
            </li>
          )}
          {routeHealth.lossMakingDirCount > 0 && (
            <li>
              {routeHealth.lossMakingDirCount} kierunków generuje łączną stratę{" "}
              {fmtEur(Math.abs(routeHealth.totalLoss))} — renegocjować stawki lub ograniczyć obsługę tych tras.
            </li>
          )}
          {payments.overdue90 > 0 && (
            <li>
              {fmtPln(payments.overdue90)} zaległości ma ponad 90 dni przeterminowania — priorytet w windykacji /
              negocjacjach z dostawcami.
            </li>
          )}
          {payments.penaltyTotal > 0 && (
            <li>
              Zweryfikujcie z księgowością {fmtPln(payments.penaltyTotal)} podejrzanych o odsetki/opłaty dodatkowe
              (sekcja Płatności powyżej) — jeśli to potwierdzone kary za spóźnienia, to konkretna, unikalna strata
              do wyeliminowania przy poprawie terminowości płatności.
            </li>
          )}
        </ul>
        <p className="text-xs text-slate-400 pt-1">
          Progi rentowności z Konfiguracji: dobra marża ≥{settings.marginGoodPct}%, niska marża ≥{settings.marginLowPct}%.
        </p>
      </section>
    </div>
  );
}

function KpiTile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: "red" | "amber" | "green" }) {
  const cls =
    tone === "red" ? "bg-red-50 text-red-700" : tone === "amber" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700";
  return (
    <div className={`rounded-xl p-4 ${cls}`}>
      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-xl font-bold mt-1">{value}</p>
      <p className="text-xs mt-0.5 opacity-70">{sub}</p>
    </div>
  );
}
