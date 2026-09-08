"use client";

import { useState, useEffect, useRef } from "react";
import {
  calculateRoute,
  COUNTRY_OPTIONS,
  FLEET,
  type RouteInput,
  type CostBreakdown as CostBreakdownType,
} from "@/lib/calculator";
import { supabase, type Vehicle } from "@/lib/supabase";
import { useSettings } from "@/lib/settings-context";
import CostBreakdownPanel from "./CostBreakdown";
import RouteFinderPanel from "./RouteFinderPanel";

const TRANSIT_PRESETS: Record<string, string[]> = {
  "PL-DE": ["PL", "DE"],
  "PL-FR": ["PL", "DE", "FR"],
  "PL-IT": ["PL", "CZ", "AT", "IT"],
  "PL-ES": ["PL", "DE", "FR", "ES"],
  "PL-NL": ["PL", "DE", "NL"],
  "PL-BE": ["PL", "DE", "BE"],
  "PL-AT": ["PL", "CZ", "AT"],
  "PL-HU": ["PL", "SK", "HU"],
  "DE-FR": ["DE", "FR"],
  "DE-IT": ["DE", "AT", "IT"],
};

export default function RouteCalculator() {
  const { settings, loading: settingsLoading } = useSettings();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [form, setForm] = useState({
    originCountry: "PL",
    destCountry: "DE",
    distanceKm: 1200,
    fuelPriceEurL: 1.25,
    vehicleReg: "",
    freightEur: 0,
    customTransit: "",
    notes: "",
  });
  const [result, setResult] = useState<CostBreakdownType | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [overrideTollEur, setOverrideTollEur] = useState<number | undefined>(undefined);
  const [showRouteFinder, setShowRouteFinder] = useState(false);

  const [trailers, setTrailers] = useState<Vehicle[]>([]);
  const [selectedTrailerReg, setSelectedTrailerReg] = useState("");

  // Formularz startuje z zaszytym fuelPriceEurL=1.25 zanim ustawienia się
  // wczytają z Supabase — bez tej synchronizacji kalkulator po cichu liczył
  // na starej cenie ON nawet gdy w /konfiguracja ustawiono inną (np. 1.30).
  const fuelPriceSynced = useRef(false);
  useEffect(() => {
    if (!settingsLoading && !fuelPriceSynced.current) {
      fuelPriceSynced.current = true;
      setForm(prev => ({ ...prev, fuelPriceEurL: settings.fuelPriceEurL }));
    }
  }, [settingsLoading, settings.fuelPriceEurL]);

  useEffect(() => {
    supabase
      .from("vehicles")
      .select("*")
      .eq("is_active", true)
      .eq("vehicle_type", "ciągnik")
      .order("reg")
      .then(({ data }) => setVehicles(data ?? []));
    supabase
      .from("vehicles")
      .select("*")
      .eq("is_active", true)
      .eq("vehicle_type", "naczepa")
      .order("reg")
      .then(({ data }) => setTrailers(data ?? []));
  }, []);

  const selectedVehicle = vehicles.find(v => v.reg === form.vehicleReg);
  const selectedTrailer = trailers.find(v => v.reg === selectedTrailerReg);

  // Fleet average trailer leasing (fallback when no specific trailer chosen)
  const fleetAvgTrailerLeasing = trailers.length
    ? trailers.reduce((sum, t) => sum + (t.leasing_eur_mo ?? 0), 0) / trailers.length
    : undefined;

  const getTransitCountries = (): string[] => {
    if (form.customTransit.trim()) {
      return form.customTransit
        .toUpperCase()
        .split(/[,\s]+/)
        .map(s => s.trim())
        .filter(Boolean);
    }
    const key = `${form.originCountry}-${form.destCountry}`;
    const rev = `${form.destCountry}-${form.originCountry}`;
    return TRANSIT_PRESETS[key] ?? TRANSIT_PRESETS[rev] ?? [form.originCountry, form.destCountry];
  };

  const handleRouteCalculated = (distanceKm: number, tollEur: number, countries: string[]) => {
    setForm(prev => ({
      ...prev,
      distanceKm,
      customTransit: countries.join(", "),
    }));
    setOverrideTollEur(tollEur > 0 ? tollEur : undefined);
  };

  const handleCalculate = () => {
    setSaved(false);
    setSaveError(null);
    const input: RouteInput = {
      originCountry: form.originCountry,
      destCountry: form.destCountry,
      distanceKm: Number(form.distanceKm),
      fuelPriceEurL: Number(form.fuelPriceEurL),
      vehicleReg: form.vehicleReg || undefined,
      avgFuelL100: selectedVehicle?.avg_fuel_l100 ?? undefined,
      freightEur: Number(form.freightEur),
      transitCountries: getTransitCountries(),
      overrideTollEur,
      leasingEurMo: selectedVehicle?.leasing_eur_mo ?? undefined,
      trailerLeasingEurMo: selectedTrailer?.leasing_eur_mo ?? fleetAvgTrailerLeasing,
      vehicleYearProduced: selectedVehicle?.year_produced ?? undefined,
    };
    setResult(calculateRoute(input, settings));
  };

  const handleSave = async () => {
    if (!result) return;
    setSaving(true);
    setSaveError(null);
    const payload = {
      origin_country: form.originCountry,
      dest_country: form.destCountry,
      distance_km: Number(form.distanceKm),
      vehicle_reg: form.vehicleReg || null,
      freight_eur: Number(form.freightEur),
      fuel_price_eur: Number(form.fuelPriceEurL),
      cost_fuel: result.fuel + result.adblue + result.idle,
      cost_toll: result.toll,
      cost_driver: result.driver,
      cost_leasing: result.leasing,
      cost_service: result.service,
      cost_total: result.total,
      margin_eur: result.marginEur,
      margin_pct: result.marginPct,
      min_freight_eur: result.minProfitableFreight,
      notes: form.notes || null,
    };
    const { error } = await supabase.from("route_calculations").insert(payload);
    setSaving(false);
    if (error) { setSaveError(error.message); return; }
    setSaved(true);
  };

  const set = (k: string, v: string | number) =>
    setForm(prev => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-6">

      {/* ── ROUTE FINDER (collapsible) ── */}
      <div>
        <button
          onClick={() => setShowRouteFinder(v => !v)}
          className="flex items-center gap-2 text-sm font-medium text-blue-700 hover:text-blue-900 transition-colors"
        >
          <span className="text-base">🗺️</span>
          {showRouteFinder ? "Ukryj kalkulator trasy" : "Oblicz trasę i myto online (HGV)"}
          <span className="text-xs opacity-60">{showRouteFinder ? "▲" : "▼"}</span>
        </button>
        {showRouteFinder && (
          <div className="mt-3">
            <RouteFinderPanel onRouteCalculated={handleRouteCalculated} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* ── FORM ── */}
      <div className="lg:col-span-2 card space-y-5">
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
          <span>📍</span> Parametry trasy
        </h2>

        {/* Origin / Dest */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Kraj załadunku</label>
            <select
              className="input-field"
              value={form.originCountry}
              onChange={e => set("originCountry", e.target.value)}
            >
              {COUNTRY_OPTIONS.map(c => (
                <option key={c.iso} value={c.iso}>{c.iso} — {c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Kraj rozładunku</label>
            <select
              className="input-field"
              value={form.destCountry}
              onChange={e => set("destCountry", e.target.value)}
            >
              {COUNTRY_OPTIONS.map(c => (
                <option key={c.iso} value={c.iso}>{c.iso} — {c.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Distance */}
        <div>
          <label className="label flex items-center gap-2">
            Odległość (km)
            {overrideTollEur != null && (
              <span className="text-xs font-normal text-emerald-600">✓ z ORS</span>
            )}
          </label>
          <input
            type="number"
            className="input-field"
            value={form.distanceKm}
            min={1}
            onChange={e => { set("distanceKm", e.target.value); setOverrideTollEur(undefined); }}
          />
        </div>

        {/* Freight price */}
        <div>
          <label className="label">Fracht (EUR)</label>
          <input
            type="number"
            className="input-field"
            value={form.freightEur}
            min={0}
            step={50}
            onChange={e => set("freightEur", e.target.value)}
            placeholder="np. 2800"
          />
        </div>

        {/* Fuel price */}
        <div>
          <label className="label">Cena ON (EUR/l)</label>
          <input
            type="number"
            className="input-field"
            value={form.fuelPriceEurL}
            min={0.5}
            max={3}
            step={0.01}
            onChange={e => set("fuelPriceEurL", e.target.value)}
          />
          <p className="text-xs text-slate-400 mt-1">
            Flota: {FLEET.avgFuelL100} l/100km
          </p>
        </div>

        {/* Vehicle */}
        <div>
          <label className="label">Pojazd (opcjonalnie)</label>
          <select
            className="input-field"
            value={form.vehicleReg}
            onChange={e => set("vehicleReg", e.target.value)}
          >
            <option value="">— Średnia floty —</option>
            {vehicles.map(v => (
              <option key={v.reg} value={v.reg}>
                {v.reg} · {v.brand} {v.model} {v.year_produced}
                {v.avg_fuel_l100 ? ` · ${v.avg_fuel_l100}l` : ""}
              </option>
            ))}
          </select>
          {selectedVehicle && (
            <p className="text-xs text-slate-400 mt-1">
              Spalanie: {selectedVehicle.avg_fuel_l100 ?? FLEET.avgFuelL100} l/100km
              · Leasing: {selectedVehicle.leasing_eur_mo ?? "—"} EUR/mies.
            </p>
          )}
        </div>

        {/* Trailer */}
        <div>
          <label className="label">Naczepa (opcjonalnie)</label>
          <select
            className="input-field"
            value={selectedTrailerReg}
            onChange={e => setSelectedTrailerReg(e.target.value)}
          >
            <option value="">— Średnia floty naczep —</option>
            {trailers.map(v => (
              <option key={v.reg} value={v.reg}>
                {v.reg}{v.year_produced ? ` · ${v.year_produced}` : ""}
                {v.leasing_eur_mo ? ` · ${v.leasing_eur_mo} EUR/mies.` : ""}
              </option>
            ))}
          </select>
          {selectedTrailer ? (
            <p className="text-xs text-slate-400 mt-1">
              Leasing: {selectedTrailer.leasing_eur_mo ?? "—"} EUR/mies.
            </p>
          ) : (
            <p className="text-xs text-slate-400 mt-1">
              Śr. floty: {fleetAvgTrailerLeasing ? `${fleetAvgTrailerLeasing.toFixed(0)} EUR/mies.` : "brak danych"}
            </p>
          )}
        </div>

        {/* Transit countries */}
        <div>
          <label className="label">Kraje tranzytowe (opcjonalnie)</label>
          <input
            type="text"
            className="input-field"
            value={form.customTransit}
            onChange={e => set("customTransit", e.target.value)}
            placeholder="np. PL, DE, AT, IT"
          />
          <p className="text-xs text-slate-400 mt-1">
            Domyślnie: preset dla tej pary krajów
          </p>
        </div>

        {/* Notes */}
        <div>
          <label className="label">Uwagi</label>
          <input
            type="text"
            className="input-field"
            value={form.notes}
            onChange={e => set("notes", e.target.value)}
            placeholder="np. klient, nr zlecenia..."
          />
        </div>

        <button onClick={handleCalculate} className="btn-primary w-full">
          Oblicz rentowność
        </button>
      </div>

      {/* ── RESULTS ── */}
      <div className="lg:col-span-3">
        {result ? (
          <CostBreakdownPanel
            result={result}
            freightEur={Number(form.freightEur)}
            distanceKm={Number(form.distanceKm)}
            onSave={handleSave}
            saving={saving}
            saved={saved}
            saveError={saveError}
          />
        ) : (
          <div className="card h-full flex items-center justify-center text-center">
            <div>
              <div className="text-5xl mb-4">📊</div>
              <p className="text-slate-500 font-medium">
                Wprowadź parametry trasy i kliknij<br />
                <strong>Oblicz rentowność</strong>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* indicator that toll was overridden by ORS */}
    {overrideTollEur != null && (
      <p className="text-xs text-emerald-700 bg-emerald-50 rounded px-3 py-1.5 inline-flex items-center gap-1">
        ✓ Myto z ORS: <strong>{overrideTollEur.toFixed(2)} EUR</strong> (rzeczywista trasa HGV)
        <button onClick={() => setOverrideTollEur(undefined)} className="ml-2 text-slate-400 hover:text-slate-600">✕</button>
      </p>
    )}
    </div>
  );
}
