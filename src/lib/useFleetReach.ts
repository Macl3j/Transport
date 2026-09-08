"use client";

import { useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import type { ReachPoint } from "@/components/CrmMap";

// Zasięg floty na mapie CRM: agreguje miejsca załadunku/rozładunku z
// route_visit_log (widok nad route_history — patrz migracja 019) tak, żeby
// handlowiec widział, gdzie flota już regularnie jeździ, i mógł tam szukać
// nowych klientów zamiast na oślep.
//
// Współrzędne miast są geokodowane raz i cache'owane w city_coordinates —
// to draga operacja (Nominatim: 1 zapytanie/s), więc nowe miasta z kolejnych
// importów TMS trzeba doganiać ręcznie przyciskiem "Zaktualizuj zasięg",
// zamiast geokodować przy każdym wejściu na mapę.

interface VisitRow { city: string; country: string; visit_date: string | null; }
interface CoordRow { city: string; country: string; lat: number | null; lng: number | null; }

export type ReachPeriod = "all" | "12m" | "6m" | "3m";

async function fetchAllPages<T>(table: string, cols: string): Promise<T[]> {
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

function periodCutoff(period: ReachPeriod): string | null {
  if (period === "all") return null;
  const months = period === "12m" ? 12 : period === "6m" ? 6 : 3;
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function useFleetReach(session: { access_token: string }) {
  const [enabled, setEnabled] = useState(false);
  const [period, setPeriod] = useState<ReachPeriod>("12m");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [coords, setCoords] = useState<Map<string, CoordRow>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [v, c] = await Promise.all([
      fetchAllPages<VisitRow>("route_visit_log", "city, country, visit_date"),
      fetchAllPages<CoordRow>("city_coordinates", "city, country, lat, lng"),
    ]);
    setVisits(v);
    const m = new Map<string, CoordRow>();
    for (const r of c) m.set(`${r.city}|${r.country}`, r);
    setCoords(m);
    setLoaded(true);
    setLoading(false);
  }, []);

  const toggle = useCallback(() => {
    setEnabled((v) => {
      const next = !v;
      if (next && !loaded) void load();
      return next;
    });
  }, [loaded, load]);

  const reachPoints: ReachPoint[] = useMemo(() => {
    if (!enabled || !loaded) return [];
    const cutoff = periodCutoff(period);
    const counts = new Map<string, number>();
    for (const v of visits) {
      if (cutoff && (!v.visit_date || v.visit_date < cutoff)) continue;
      const k = `${v.city}|${v.country}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const points: ReachPoint[] = [];
    for (const [k, visitCount] of counts) {
      const coord = coords.get(k);
      if (coord?.lat != null && coord?.lng != null) {
        const [city, country] = k.split("|");
        points.push({ city, country, lat: coord.lat, lng: coord.lng, visits: visitCount });
      }
    }
    return points;
  }, [enabled, loaded, visits, coords, period]);

  const totalUniqueCities = useMemo(() => new Set(visits.map((v) => `${v.city}|${v.country}`)).size, [visits]);
  const geocodedCities = useMemo(() => [...coords.values()].filter((c) => c.lat != null).length, [coords]);

  const refreshCoverage = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const allPairs = new Map<string, { city: string; country: string }>();
      for (const v of visits) allPairs.set(`${v.city}|${v.country}`, { city: v.city, country: v.country });
      const todo = [...allPairs.entries()].filter(([k]) => !coords.has(k)).map(([, val]) => val);
      setRefreshProgress({ done: 0, total: todo.length });
      const newCoords = new Map(coords);
      for (let i = 0; i < todo.length; i++) {
        const { city, country } = todo[i];
        try {
          const res = await fetch("/api/crm/geocode", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ query: `${city}, ${country}` }),
          });
          const json = await res.json();
          const lat = json.ok ? json.lat : null;
          const lng = json.ok ? json.lng : null;
          await supabase.from("city_coordinates").upsert(
            { city, country, lat, lng, geocoded_at: new Date().toISOString() },
            { onConflict: "city,country" }
          );
          newCoords.set(`${city}|${country}`, { city, country, lat, lng });
        } catch {
          // Jedno potknięcie Nominatim nie powinno przerywać całej partii — lecimy dalej.
        }
        setRefreshProgress({ done: i + 1, total: todo.length });
        if (i < todo.length - 1) await new Promise((r) => setTimeout(r, 1100));
      }
      setCoords(newCoords);
    } finally {
      setRefreshing(false);
      setRefreshProgress(null);
    }
  }, [visits, coords, refreshing, session.access_token]);

  return {
    enabled, toggle, period, setPeriod, loading, loaded,
    reachPoints, totalUniqueCities, geocodedCities,
    refreshCoverage, refreshing, refreshProgress,
  };
}
