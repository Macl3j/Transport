-- ============================================================
-- Rozszerzenie route_history o pola dostępne w rejestrze transportów,
-- ale dotąd nieimportowane: km wg zleceniodawcy (dyscyplina danych do
-- systemu premiowego dyspozytorów), km puste (dokładniejsza marża —
-- dotąd liczona tylko z km ładownych), przewoźnik i koszt przewoźnego
-- (rozróżnienie zleceń realizowanych własnym taborem/Ali-Woj od
-- spedycji na obcy tabor) oraz osoba tworząca zlecenie (przypisanie
-- do dyspozytora niezależne od pojazdu — potrzebne właśnie dla spedycji,
-- gdzie nie ma własnego ciągnika w zleceniu).
-- ============================================================

alter table route_history
  add column if not exists km_client numeric,
  add column if not exists km_empty numeric,
  add column if not exists carrier_name text,
  add column if not exists carrier_cost_eur numeric,
  add column if not exists carrier_currency text,
  add column if not exists created_by text;
