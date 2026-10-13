"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { type CalcSettings } from "@/lib/calculator";

// ─── Full app settings (superset of CalcSettings) ────────────
export interface AppSettings extends CalcSettings {
  fuelPriceEurL:    number;
  plnEurRate:       number;
  // Budget module settings
  kmTargetMo?:      number;   // min km/month per tractor (default 10 000)
  tollEurPerKm?:    number;   // avg toll EUR/km (default 0.30)
  budgetMarginPct?: number;   // target margin % (default 10)
}

export const SETTINGS_DEFAULTS: AppSettings = {
  leasingMethod:        "per_dobe",
  trailerLeasingMethod: "per_dobe",
  insuranceMethod:      "per_dobe",
  fuelPriceEurL:        1.25,
  plnEurRate:           4.25,
  avgFuelL100:          27.80,
  driverDailyCost:      181.95,
  adblueRatePct:        3.5,
  idleFuelPct:          2.1,
  avgKmPerMonth:        11_667,
  marginGoodPct:        15,
  marginLowPct:         5,
  kmTargetMo:           10_000,
  tollEurPerKm:         0.30,
  budgetMarginPct:      10,
  idleFleetCostPlnMo:   0,
  financingCostPlnMo:   0,
  overheadFleetSize:    51,
};

interface SettingsCtx {
  settings:    AppSettings;
  loading:     boolean;
  reload:      () => Promise<void>;
  save:        (updates: Partial<AppSettings>) => Promise<void>;
}

const SettingsContext = createContext<SettingsCtx>({
  settings: SETTINGS_DEFAULTS,
  loading:  true,
  reload:   async () => {},
  save:     async () => {},
});

// ─── Map Supabase rows → AppSettings ─────────────────────────
function rowsToSettings(rows: { key: string; value: string }[]): AppSettings {
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  return {
    leasingMethod:        (map.leasing_method         ?? "per_dobe") as AppSettings["leasingMethod"],
    trailerLeasingMethod: (map.trailer_leasing_method ?? "per_dobe") as AppSettings["trailerLeasingMethod"],
    insuranceMethod:      (map.insurance_method       ?? "per_dobe") as AppSettings["insuranceMethod"],
    fuelPriceEurL:        Number(map.fuel_price_eur_l   ?? 1.25),
    plnEurRate:           Number(map.pln_eur_rate        ?? 4.25),
    avgFuelL100:          Number(map.avg_fuel_l100       ?? 27.80),
    driverDailyCost:      Number(map.driver_daily_cost   ?? 181.95),
    adblueRatePct:        Number(map.adblue_rate_pct     ?? 3.5),
    idleFuelPct:          Number(map.idle_fuel_pct       ?? 2.1),
    avgKmPerMonth:        Number(map.avg_km_per_month    ?? 11667),
    marginGoodPct:        Number(map.margin_good_pct     ?? 15),
    marginLowPct:         Number(map.margin_low_pct      ?? 5),
    kmTargetMo:           Number(map.km_target_mo        ?? 10000),
    tollEurPerKm:         Number(map.toll_eur_per_km     ?? 0.30),
    budgetMarginPct:      Number(map.budget_margin_pct   ?? 10),
    idleFleetCostPlnMo:   Number(map.idle_fleet_cost_pln_mo ?? 0),
    financingCostPlnMo:   Number(map.financing_cost_pln_mo  ?? 0),
    overheadFleetSize:    Number(map.overhead_fleet_size    ?? 51),
  };
}

// ─── Map AppSettings field → Supabase key ────────────────────
const FIELD_TO_KEY: Record<keyof AppSettings, string> = {
  leasingMethod:        "leasing_method",
  trailerLeasingMethod: "trailer_leasing_method",
  insuranceMethod:      "insurance_method",
  fuelPriceEurL:        "fuel_price_eur_l",
  plnEurRate:           "pln_eur_rate",
  avgFuelL100:          "avg_fuel_l100",
  driverDailyCost:      "driver_daily_cost",
  adblueRatePct:        "adblue_rate_pct",
  idleFuelPct:          "idle_fuel_pct",
  avgKmPerMonth:        "avg_km_per_month",
  marginGoodPct:        "margin_good_pct",
  marginLowPct:         "margin_low_pct",
  kmTargetMo:           "km_target_mo",
  tollEurPerKm:         "toll_eur_per_km",
  budgetMarginPct:      "budget_margin_pct",
  idleFleetCostPlnMo:   "idle_fleet_cost_pln_mo",
  financingCostPlnMo:   "financing_cost_pln_mo",
  overheadFleetSize:    "overhead_fleet_size",
};

// ─── Provider ────────────────────────────────────────────────
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(SETTINGS_DEFAULTS);
  const [loading,  setLoading]  = useState(true);

  const reload = async () => {
    const { data } = await supabase
      .from("settings")
      .select("key, value");
    if (data && data.length > 0) {
      setSettings(rowsToSettings(data));
    }
    setLoading(false);
  };

  const save = async (updates: Partial<AppSettings>) => {
    const upsertRows = Object.entries(updates).map(([field, val]) => ({
      key:        FIELD_TO_KEY[field as keyof AppSettings],
      value:      String(val),
      label:      field,
      updated_at: new Date().toISOString(),
    }));
    await supabase.from("settings").upsert(upsertRows, { onConflict: "key" });
    setSettings(prev => ({ ...prev, ...updates }));
  };

  useEffect(() => { reload(); }, []);

  return (
    <SettingsContext.Provider value={{ settings, loading, reload, save }}>
      {children}
    </SettingsContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────────
export function useSettings(): SettingsCtx {
  return useContext(SettingsContext);
}
