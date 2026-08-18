// ============================================================
// crmAuth.ts — HBM TruckCalc
// SERVER-ONLY: weryfikacja sesji logowania w route handlerach CRM.
//
// API routes pod /api/crm/** używają createServiceClient() (klucz
// service_role), który CAŁKOWICIE omija RLS. RLS chroni więc tylko
// zapytania idące wprost z przeglądarki (supabase.from(...)) — te
// route'y trzeba osobno zabezpieczyć, inaczej logowanie na resztę
// CRM-u nie chroniłoby haseł do portali przetargowych.
// ============================================================

import { createClient } from "@supabase/supabase-js";

/**
 * Sprawdza nagłówek Authorization: Bearer <access_token> z żądania.
 * Zwraca zalogowanego użytkownika albo null, jeśli token jest
 * nieobecny/nieważny.
 */
export async function getAuthedUser(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  // Weryfikacja tokenu wymaga klucza anon (nie service_role) — to zwykły
  // klient GoTrue, sprawdzamy tylko czy token jest ważną sesją użytkownika.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}
