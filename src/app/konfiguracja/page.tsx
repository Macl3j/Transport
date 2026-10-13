"use client";

import { useEffect, useState } from "react";
import { useSettings, type AppSettings } from "@/lib/settings-context";
import { supabase } from "@/lib/supabase";

// ─── Helpers ─────────────────────────────────────────────────
type Method = "per_dobe" | "per_km";

function MethodToggle({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: Method;
  onChange: (v: Method) => void;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-100 last:border-0">
      <div>
        <p className="text-sm font-medium text-slate-800">{label}</p>
        <p className="text-xs text-slate-400 mt-0.5">{description}</p>
      </div>
      <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5 ml-4 shrink-0">
        <button
          onClick={() => onChange("per_dobe")}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            value === "per_dobe"
              ? "bg-white shadow text-blue-700"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Per dobę
        </button>
        <button
          onClick={() => onChange("per_km")}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
            value === "per_km"
              ? "bg-white shadow text-slate-800"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Per km
        </button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  description,
  value,
  unit,
  step,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  unit?: string;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-slate-100 last:border-0">
      <div className="flex-1 pr-4">
        <p className="text-sm font-medium text-slate-800">{label}</p>
        <p className="text-xs text-slate-400 mt-0.5">{description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <input
          type="number"
          className="w-28 border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-right font-mono focus:outline-none focus:ring-2 focus:ring-blue-400"
          value={value}
          step={step ?? 0.01}
          onChange={e => onChange(Number(e.target.value))}
        />
        {unit && <span className="text-xs text-slate-400 w-16">{unit}</span>}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────
export default function KonfiguracjaPage() {
  const { settings, loading, save } = useSettings();
  const [local, setLocal] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  // Podpowiedź z bazy floty: koszt pojazdów wyłączonych z eksploatacji i liczba aktywnych ciągników
  const [fleetHint, setFleetHint] = useState<{ inactiveCount: number; inactiveEurMo: number; activeTractors: number } | null>(null);
  useEffect(() => {
    supabase.from("vehicles")
      .select("vehicle_type,is_active,leasing_eur_mo,insurance_eur_mo")
      .then(({ data }) => {
        if (!data) return;
        const inactive = data.filter(v => !v.is_active);
        setFleetHint({
          inactiveCount: inactive.length,
          inactiveEurMo: inactive.reduce((s, v) => s + (Number(v.leasing_eur_mo) || 0) + (Number(v.insurance_eur_mo) || 0), 0),
          activeTractors: data.filter(v => v.is_active && v.vehicle_type === "ciągnik").length,
        });
      });
  }, []);

  // Use local draft if editing, else live settings
  const cur = local ?? settings;

  const set = <K extends keyof AppSettings>(key: K, val: AppSettings[K]) => {
    setSaved(false);
    setLocal(prev => ({ ...(prev ?? settings), [key]: val }));
  };

  const handleSave = async () => {
    if (!local) return;
    setSaving(true);
    await save(local);
    setSaving(false);
    setSaved(true);
    setLocal(null);
  };

  const handleReset = () => { setLocal(null); setSaved(false); };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-400">
        <span className="text-sm">Wczytywanie ustawień…</span>
      </div>
    );
  }

  const isDirty = local !== null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">⚙️ Konfiguracja</h1>
          <p className="text-sm text-slate-500 mt-1">
            Globalne parametry kalkulatora — stosowane we wszystkich analizach
          </p>
        </div>
        <div className="flex gap-2">
          {isDirty && (
            <button
              onClick={handleReset}
              className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 border border-slate-200 hover:bg-slate-50"
            >
              Anuluj
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              saved
                ? "bg-emerald-500 text-white"
                : isDirty
                  ? "bg-blue-700 hover:bg-blue-800 text-white"
                  : "bg-slate-200 text-slate-400 cursor-not-allowed"
            }`}
          >
            {saved ? "✓ Zapisano" : saving ? "Zapisuję…" : "Zapisz zmiany"}
          </button>
        </div>
      </div>

      {isDirty && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-xs text-amber-700">
          Masz niezapisane zmiany — kliknij <strong>Zapisz zmiany</strong> aby zastosować.
        </div>
      )}

      {/* ── Metody alokacji ── */}
      <div className="card">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="font-bold text-slate-800">📐 Metody alokacji kosztów stałych</h2>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          <strong>Per dobę</strong> — koszt stały ÷ 30 × dni trasy (rekomendowane dla TIR, IRU/BGL standard).<br />
          <strong>Per km</strong> — koszt stały ÷ avg_km/mies. × km trasy (prostsze, ale zaniża koszty przy postojach).
        </p>
        <MethodToggle
          label="Leasing ciągnika"
          description="Rata leasingowa ciągnika alokowana na trasę"
          value={cur.leasingMethod}
          onChange={v => set("leasingMethod", v)}
        />
        <MethodToggle
          label="Leasing naczepy"
          description="Rata leasingowa naczepy alokowana na trasę"
          value={cur.trailerLeasingMethod}
          onChange={v => set("trailerLeasingMethod", v)}
        />
        <MethodToggle
          label="Ubezpieczenie OC+AC"
          description="Składka ubezpieczeniowa alokowana na trasę"
          value={cur.insuranceMethod}
          onChange={v => set("insuranceMethod", v)}
        />
      </div>

      {/* ── Stawki flotowe ── */}
      <div className="card">
        <h2 className="font-bold text-slate-800 mb-1">⛽ Stawki domyślne flotowe</h2>
        <p className="text-xs text-slate-400 mb-4">
          Używane gdy brak danych per-pojazd. Aktualizuj regularnie (cena ON, kurs, spalanie z Trimble).
        </p>
        <NumberField
          label="Cena ON"
          description="Domyślna cena oleju napędowego"
          value={cur.fuelPriceEurL}
          unit="EUR/l"
          step={0.01}
          onChange={v => set("fuelPriceEurL", v)}
        />
        <NumberField
          label="Kurs PLN/EUR"
          description="Do przeliczania myto PLN→EUR z TMS"
          value={cur.plnEurRate}
          unit="PLN/EUR"
          step={0.01}
          onChange={v => set("plnEurRate", v)}
        />
        <NumberField
          label="Spalanie flotowe"
          description="Średnie spalanie floty — aktualizuj z Trimble FMS"
          value={cur.avgFuelL100 ?? 27.80}
          unit="l/100km"
          step={0.1}
          onChange={v => set("avgFuelL100", v)}
        />
        <NumberField
          label="Koszt kierowcy"
          description="Koszt netto za dobę pracy (agencja pracy)"
          value={cur.driverDailyCost ?? 181.95}
          unit="EUR/dobę"
          step={0.5}
          onChange={v => set("driverDailyCost", v)}
        />
        <NumberField
          label="AdBlue"
          description="Zużycie AdBlue jako % zużycia ON"
          value={cur.adblueRatePct ?? 3.5}
          unit="% paliwa"
          step={0.1}
          onChange={v => set("adblueRatePct", v)}
        />
        <NumberField
          label="Bieg jałowy"
          description="Straty paliwa na biegu jałowym (z Trimble FMS)"
          value={cur.idleFuelPct ?? 2.1}
          unit="% paliwa"
          step={0.1}
          onChange={v => set("idleFuelPct", v)}
        />
        <NumberField
          label="Średnie km/miesiąc"
          description="Fallback gdy brak danych pojazdu (140 000 km/rok)"
          value={cur.avgKmPerMonth ?? 11667}
          unit="km/mies."
          step={100}
          onChange={v => set("avgKmPerMonth", v)}
        />
      </div>

      {/* ── Koszty rozkładane na wszystkie trasy ── */}
      <div className="card">
        <h2 className="font-bold text-slate-800 mb-1">🧮 Koszty rozkładane na wszystkie trasy</h2>
        <p className="text-xs text-slate-400 mb-4">
          Kwota miesięczna na <strong>całą flotę</strong> jest dzielona przez liczbę ciągników i doliczana do każdej trasy
          proporcjonalnie do jej czasu: kwota ÷ ciągniki ÷ 30 × doby trasy. Wartość 0 = pozycja wyłączona.
          Zmiana wpływa na marżę we wszystkich analizach (kalkulator, dyspozytorzy, koła, analiza).
        </p>
        <NumberField
          label="Koszty pojazdów, które nie jeżdżą"
          description="Leasingi, ubezpieczenia i inne koszty pojazdów wyłączonych z eksploatacji, które i tak generują koszt"
          value={cur.idleFleetCostPlnMo ?? 0}
          unit="PLN/mies."
          step={1000}
          onChange={v => set("idleFleetCostPlnMo", v)}
        />
        {fleetHint && (
          <div className="flex items-center justify-between gap-3 -mt-1 mb-2 pb-3 border-b border-slate-100 text-xs text-slate-500">
            <span>
              Z bazy: {fleetHint.inactiveCount} nieaktywnych pojazdów, leasing + ubezpieczenie ≈{" "}
              <strong>{Math.round(fleetHint.inactiveEurMo).toLocaleString("pl-PL")} EUR</strong> ≈{" "}
              <strong>{Math.round(fleetHint.inactiveEurMo * cur.plnEurRate).toLocaleString("pl-PL")} PLN</strong> miesięcznie
              (bez innych kosztów, np. podatku, parkingu)
            </span>
            <button
              type="button"
              className="shrink-0 px-2.5 py-1 rounded-md border border-slate-200 hover:bg-slate-50 text-slate-600"
              onClick={() => set("idleFleetCostPlnMo", Math.round(fleetHint.inactiveEurMo * cur.plnEurRate))}
            >
              Użyj tej kwoty
            </button>
          </div>
        )}
        <NumberField
          label="Koszty finansowania floty"
          description="Odsetki od kredytów i inne koszty finansowania (np. 35 000 PLN)"
          value={cur.financingCostPlnMo ?? 0}
          unit="PLN/mies."
          step={1000}
          onChange={v => set("financingCostPlnMo", v)}
        />
        <NumberField
          label="Liczba ciągników do podziału"
          description="Przez tyle sztuk dzielone są powyższe kwoty"
          value={cur.overheadFleetSize ?? 51}
          unit="ciągników"
          step={1}
          onChange={v => set("overheadFleetSize", Math.max(1, Math.round(v)))}
        />
        {fleetHint && (
          <div className="flex items-center justify-between gap-3 -mt-1 mb-2 pb-3 border-b border-slate-100 text-xs text-slate-500">
            <span>Z bazy: <strong>{fleetHint.activeTractors}</strong> aktywnych ciągników</span>
            <button
              type="button"
              className="shrink-0 px-2.5 py-1 rounded-md border border-slate-200 hover:bg-slate-50 text-slate-600"
              onClick={() => set("overheadFleetSize", fleetHint.activeTractors)}
            >
              Użyj tej liczby
            </button>
          </div>
        )}
        {(() => {
          const n = Math.max(1, cur.overheadFleetSize ?? 51);
          const perDay = (((cur.idleFleetCostPlnMo ?? 0) + (cur.financingCostPlnMo ?? 0)) / cur.plnEurRate) / n / 30;
          return (
            <p className="text-xs text-slate-500 pt-1">
              Obciążenie jednej doby jazdy: <strong>{perDay.toFixed(2)} EUR</strong>
              {" "}(trasa 3-dobowa: {(perDay * 3).toFixed(2)} EUR)
            </p>
          );
        })()}
      </div>

      {/* ── Progi rentowności ── */}
      <div className="card">
        <h2 className="font-bold text-slate-800 mb-1">📊 Progi rentowności</h2>
        <p className="text-xs text-slate-400 mb-4">
          Definiują kolory i etykiety marży w tabelach i raportach.
        </p>
        <div className="flex gap-3 mb-4">
          <div className="flex items-center gap-2 bg-emerald-50 rounded-lg px-3 py-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            <span className="text-xs font-semibold text-emerald-700">
              Rentowna ≥ {cur.marginGoodPct}%
            </span>
          </div>
          <div className="flex items-center gap-2 bg-amber-50 rounded-lg px-3 py-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
            <span className="text-xs font-semibold text-amber-700">
              Niska marża {cur.marginLowPct}–{cur.marginGoodPct}%
            </span>
          </div>
          <div className="flex items-center gap-2 bg-orange-50 rounded-lg px-3 py-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-orange-400" />
            <span className="text-xs font-semibold text-orange-700">
              Próg 0–{cur.marginLowPct}%
            </span>
          </div>
          <div className="flex items-center gap-2 bg-red-50 rounded-lg px-3 py-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
            <span className="text-xs font-semibold text-red-700">Strata &lt; 0%</span>
          </div>
        </div>
        <NumberField
          label="Próg dobrej marży"
          description="Marża równa lub powyżej → Rentowna (zielona)"
          value={cur.marginGoodPct ?? 15}
          unit="%"
          step={1}
          onChange={v => set("marginGoodPct", v)}
        />
        <NumberField
          label="Próg niskiej marży"
          description="Marża między tym a dobrym → Niska marża (żółta)"
          value={cur.marginLowPct ?? 5}
          unit="%"
          step={1}
          onChange={v => set("marginLowPct", v)}
        />
      </div>

    </div>
  );
}
