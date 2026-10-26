// ============================================================
// costImport.ts — wspólny import faktur kosztowych (cost_invoices)
// dla stron Płatności i Windykacja.
//
// Dlaczego nie "skasuj wszystko i wstaw od nowa": akceptacje płatności
// (payment_approvals.cost_invoice_id, migracja 023) wskazują na konkretne wiersze
// cost_invoices przez id. Kasowanie faktury z akceptacją kończy się błędem klucza
// obcego, a wstawienie jej na nowo zerwałoby powiązanie. Dlatego import SYNCHRONIZUJE:
//  1) faktura z pliku znaleziona w bazie (numer + sprzedawca + data wystawienia)
//     jest AKTUALIZOWANA na miejscu — id i powiązane akceptacje zostają,
//  2) faktury nowe są dopisywane,
//  3) faktury z okna pokrytego plikiem, których w pliku już nie ma, są usuwane;
//     jeśli faktura ma akceptację (błąd klucza obcego), zostaje w bazie i jest liczona
//     w raporcie jako "zostawiona",
//  4) starsza historia (przed oknem pliku, np. 2024–2025 — korzystają z niej analizy na
//     stronie Płatności) nie jest ruszana.
// Błąd zapisu w trakcie nigdy nie kasuje danych: każdy wiersz jest albo stary, albo już
// zaktualizowany, a ponowne wczytanie tego samego pliku dokańcza synchronizację.
// Wiersze bez numeru faktury (wiersz sum na dole eksportu Rokos) są pomijane.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { message?: string; details?: string; hint?: string; code?: string };
    const parts = [o.message, o.details, o.hint].filter(Boolean);
    if (parts.length > 0) return parts.join(" — ") + (o.code ? ` (${o.code})` : "");
    try { return JSON.stringify(e); } catch { /* ignoruj */ }
  }
  return String(e);
}

/** Początek okna pokrytego plikiem: pierwszy dzień najwcześniejszego miesiąca z co najmniej 50 fakturami
 *  (kilka faktur z poprzedniego miesiąca to „ogonki”, np. sprzedaż w styczniu, wystawione w grudniu).
 *  Gdy żaden miesiąc nie ma 50 faktur (mały plik) — najwcześniejsza data wystawienia. */
export function costWindowStart(rows: { data_wystawienia?: unknown }[]): string | null {
  const dates = rows.map((r) => (typeof r.data_wystawienia === "string" ? r.data_wystawienia : null)).filter((x): x is string => !!x).sort();
  if (dates.length === 0) return null;
  const perMonth = new Map<string, number>();
  dates.forEach((d) => perMonth.set(d.slice(0, 7), (perMonth.get(d.slice(0, 7)) ?? 0) + 1));
  const dense = [...perMonth.entries()].filter(([, n]) => n >= 50).map(([m]) => m).sort();
  return dense.length > 0 ? dense[0] + "-01" : dates[0];
}

const keyOf = (r: { numer?: unknown; sprzedawca?: unknown; data_wystawienia?: unknown }) =>
  `${String(r.numer ?? "").trim()}|${String(r.sprzedawca ?? "").trim().toLowerCase()}|${typeof r.data_wystawienia === "string" ? r.data_wystawienia : ""}`;

export interface CostSyncResult {
  imported: number;        // faktur w pliku (z numerem)
  updated: number;         // zaktualizowanych na miejscu
  inserted: number;        // nowych
  deleted: number;         // usuniętych nieaktualnych
  keptStale: number;       // nieaktualnych, których nie wolno usunąć (mają akceptacje płatności)
  skippedNoNumber: number; // pominięte wiersze bez numeru
  windowStart: string | null;
}

export async function replaceCostInvoices(supabase: SupabaseClient, rows: object[]): Promise<CostSyncResult> {
  const all = rows as Record<string, unknown>[];
  const file = all.filter((r) => typeof r.numer === "string" && r.numer.trim() !== "");
  const skippedNoNumber = all.length - file.length;
  if (file.length === 0) throw new Error("Plik nie zawiera faktur z numerem.");
  const stamp = new Date().toISOString();
  const windowStart = costWindowStart(file as { data_wystawienia?: unknown }[]);

  // 1) istniejące faktury (tylko pola potrzebne do dopasowania)
  const existing: { id: string; numer: string | null; sprzedawca: string | null; data_wystawienia: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("cost_invoices").select("id,numer,sprzedawca,data_wystawienia").order("id").range(from, from + 999);
    if (error) throw new Error("Nie udało się odczytać faktur z bazy, nic nie zmieniono: " + errMsg(error));
    existing.push(...((data ?? []) as typeof existing));
    if (!data || data.length < 1000) break;
  }
  const byKey = new Map<string, string[]>();
  existing.forEach((e) => { const k = keyOf(e); byKey.set(k, [...(byKey.get(k) ?? []), e.id]); });

  // 2) podział: dopasowane (aktualizacja po id) i nowe
  const toUpdate: Record<string, unknown>[] = [];
  const toInsert: Record<string, unknown>[] = [];
  const matched = new Set<string>();
  for (const r of file) {
    const ids = byKey.get(keyOf(r));
    const id = ids && ids.length > 0 ? ids.shift() : undefined;
    const row = { ...r, imported_at: stamp };
    if (id) { matched.add(id); toUpdate.push({ ...row, id }); } else toInsert.push(row);
  }

  const withFallback = async (batch: Record<string, unknown>[], run: (b: Record<string, unknown>[]) => PromiseLike<{ error: { message: string } | null }>) => {
    let res = await run(batch);
    // kolumna odbiorca pochodzi z migracji 032; bez niej zapisujemy jak dotąd
    if (res.error && /odbiorca/i.test(res.error.message)) {
      res = await run(batch.map((r) => { const { odbiorca: _o, ...rest } = r; void _o; return rest; }));
    }
    return res;
  };

  // 3) aktualizacje na miejscu (upsert po kluczu głównym id) i nowe faktury
  for (let i = 0; i < toUpdate.length; i += 500) {
    const { error } = await withFallback(toUpdate.slice(i, i + 500), (b) => supabase.from("cost_invoices").upsert(b as never[], { onConflict: "id" }));
    if (error) throw new Error(`Aktualizacja faktur nie powiodła się (zaktualizowano ${i} z ${toUpdate.length}; dane są spójne, ponowne wczytanie pliku dokończy): ` + errMsg(error));
  }
  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await withFallback(toInsert.slice(i, i + 500), (b) => supabase.from("cost_invoices").insert(b as never[]));
    if (error) throw new Error(`Zapis nowych faktur nie powiódł się (dopisano ${i} z ${toInsert.length}; ponowne wczytanie pliku dokończy): ` + errMsg(error));
  }
  const check = await supabase.from("cost_invoices").select("id", { count: "exact", head: true }).eq("imported_at", stamp);
  if (check.error || check.count !== file.length) {
    throw new Error(`Po zapisie w bazie jest ${check.count ?? "?"} z ${file.length} faktur z pliku. Wczytaj plik ponownie.${check.error ? " " + errMsg(check.error) : ""}`);
  }

  // 4) nieaktualne: z okna pliku (lub bez daty wystawienia), nieobecne w pliku
  const stale = existing.filter((e) => !matched.has(e.id) && (!e.data_wystawienia || (windowStart !== null && e.data_wystawienia >= windowStart))).map((e) => e.id);
  let deleted = 0, keptStale = 0;
  for (let i = 0; i < stale.length; i += 100) {
    const chunk = stale.slice(i, i + 100);
    const d = await supabase.from("cost_invoices").delete().in("id", chunk);
    if (!d.error) { deleted += chunk.length; continue; }
    // któraś z faktur ma akceptację płatności (klucz obcy) — usuwamy pojedynczo, resztę zostawiamy
    for (const id of chunk) {
      const one = await supabase.from("cost_invoices").delete().eq("id", id);
      if (!one.error) deleted++;
      else if ((one.error as { code?: string }).code === "23503" || /foreign key/i.test(one.error.message)) keptStale++;
      else throw new Error("Nie udało się usunąć nieaktualnych faktur: " + errMsg(one.error));
    }
  }
  return { imported: file.length, updated: toUpdate.length, inserted: toInsert.length, deleted, keptStale, skippedNoNumber, windowStart };
}

/** Jednozdaniowy opis wyniku do pokazania użytkownikowi. */
export function describeSync(r: CostSyncResult): string {
  const parts = [`${r.imported} faktur z pliku: ${r.updated} zaktualizowanych, ${r.inserted} nowych, ${r.deleted} nieaktualnych usuniętych`];
  if (r.keptStale > 0) parts.push(`${r.keptStale} nieaktualnych zostawiono, bo mają akceptacje płatności`);
  if (r.skippedNoNumber > 0) parts.push(`pominięto ${r.skippedNoNumber} wiersz bez numeru (suma na dole eksportu)`);
  if (r.windowStart) parts.push(`okno od ${r.windowStart}, starsza historia bez zmian`);
  return parts.join("; ") + ".";
}
