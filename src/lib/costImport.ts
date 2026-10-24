// ============================================================
// costImport.ts — wspólny, bezpieczny import faktur kosztowych (cost_invoices)
// dla stron Płatności i Windykacja.
//
// Dotychczasowy import najpierw KASOWAŁ wszystkie faktury, a dopiero potem
// zapisywał nowe; błąd w połowie zostawiał pustą lub niepełną tabelę, a komunikat
// błędu Supabase pokazywał się jako "[object Object]". Teraz:
//  1) najpierw zapis nowych faktur ze wspólnym znacznikiem imported_at,
//  2) kontrola, że w bazie jest tyle nowych faktur, ile w pliku,
//  3) dopiero potem usunięcie starych faktur Z OKNA POKRYTEGO PLIKIEM i kontrola,
//     że żadna stara z tego okna nie została. Starsza historia (np. 2024–2025, którą
//     wykorzystują analizy na stronie Płatności) zostaje, gdy plik zaczyna się później,
//  4) przy jakimkolwiek błędzie wycofanie nowych — stare dane zostają nietknięte.
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

export async function replaceCostInvoices(supabase: SupabaseClient, rows: object[]): Promise<{ imported: number; skippedNoNumber: number; windowStart: string | null }> {
  const all = rows as Record<string, unknown>[];
  const tagged0 = all.filter((r) => typeof r.numer === "string" && r.numer.trim() !== "");
  const skippedNoNumber = all.length - tagged0.length;
  if (tagged0.length === 0) throw new Error("Plik nie zawiera faktur z numerem.");
  const stamp = new Date().toISOString();
  const tagged: Record<string, unknown>[] = tagged0.map((r) => ({ ...r, imported_at: stamp }));

  const insert = async (batch: Record<string, unknown>[]) => {
    let res = await supabase.from("cost_invoices").insert(batch as never[]);
    // kolumna odbiorca pochodzi z migracji 032; bez niej zapisujemy jak dotąd
    if (res.error && /odbiorca/i.test(res.error.message)) {
      const stripped = batch.map((r) => { const { odbiorca: _o, ...rest } = r; void _o; return rest; });
      res = await supabase.from("cost_invoices").insert(stripped as never[]);
    }
    return res;
  };
  const rollback = async () => { await supabase.from("cost_invoices").delete().eq("imported_at", stamp); };

  // Próba przed jakąkolwiek zmianą: czy baza pozwala zapisywać ORAZ kasować. Gdy kasowanie jest
  // po cichu blokowane (np. RLS bez polityki DELETE), nowe faktury zapisałyby się obok starych
  // i nie dałoby się ich wycofać. Wiersz próbny ma stary imported_at, więc kolejny udany import go usunie.
  const probe = await supabase.from("cost_invoices").insert({ numer: "__test_importu__", imported_at: "1970-01-01T00:00:00Z" } as never);
  if (probe.error) throw new Error("Baza nie pozwala zapisywać faktur, import przerwany, stare dane bez zmian: " + errMsg(probe.error));
  await supabase.from("cost_invoices").delete().eq("numer", "__test_importu__");
  const left = await supabase.from("cost_invoices").select("id", { count: "exact", head: true }).eq("numer", "__test_importu__");
  if (left.count) throw new Error("Baza nie pozwala kasować faktur (prawdopodobnie brak uprawnienia DELETE lub RLS), import przerwany, stare dane bez zmian.");

  for (let i = 0; i < tagged.length; i += 500) {
    const { error } = await insert(tagged.slice(i, i + 500));
    if (error) { await rollback(); throw new Error("Zapis nowych faktur nie powiódł się, stare dane zostały bez zmian: " + errMsg(error)); }
  }
  const nw = await supabase.from("cost_invoices").select("id", { count: "exact", head: true }).eq("imported_at", stamp);
  if (nw.error || nw.count !== tagged.length) {
    await rollback();
    throw new Error(`Po zapisie w bazie jest ${nw.count ?? "?"} z ${tagged.length} nowych faktur, stare dane zostały bez zmian.${nw.error ? " " + errMsg(nw.error) : ""}`);
  }
  const windowStart = costWindowStart(tagged as { data_wystawienia?: unknown }[]);
  const fail = async (what: string, e?: unknown) => { await rollback(); throw new Error(`${what} (nowe wycofano, stare bez zmian)${e ? ": " + errMsg(e) : "."}`); };
  // 1) stare faktury z okna pliku (wystawione od początku okna) oraz stare bez daty wystawienia (np. wiersz sum)
  if (windowStart) {
    const d1 = await supabase.from("cost_invoices").delete().lt("imported_at", stamp).gte("data_wystawienia", windowStart);
    if (d1.error) return fail("Nie udało się usunąć starych faktur", d1.error);
  }
  const d2 = await supabase.from("cost_invoices").delete().lt("imported_at", stamp).is("data_wystawienia", null);
  if (d2.error) return fail("Nie udało się usunąć starych faktur bez daty", d2.error);
  // 2) „ogonki”: faktury z pliku wystawione przed oknem — usuń ich stare wersje po numerze, żeby się nie dublowały
  const tails = windowStart ? tagged.filter((r) => typeof r.data_wystawienia === "string" && (r.data_wystawienia as string) < windowStart).map((r) => r.numer as string) : [];
  for (let i = 0; i < tails.length; i += 100) {
    const d3 = await supabase.from("cost_invoices").delete().lt("imported_at", stamp).in("numer", tails.slice(i, i + 100));
    if (d3.error) return fail("Nie udało się usunąć starych wersji faktur", d3.error);
  }
  // kontrola: nic starego z okna nie może zostać
  const old = windowStart
    ? await supabase.from("cost_invoices").select("id", { count: "exact", head: true }).lt("imported_at", stamp).gte("data_wystawienia", windowStart)
    : { count: 0, error: null };
  if (old.count) return fail(`Baza nie pozwoliła usunąć starych faktur (zostało ${old.count}), prawdopodobnie brak uprawnienia do kasowania`);
  return { imported: tagged.length, skippedNoNumber, windowStart };
}
