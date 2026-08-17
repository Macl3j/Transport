-- ============================================================
-- TruckCalc HBM — CRM: napraw widoczność dla klucza anon
-- Tabele z migracji 008 były niewidoczne w kliencie (anon key
-- zwracał pustą listę) mimo że dane istnieją — sygnatura RLS
-- włączonego bez polityk (service_role zawsze omija RLS, anon nie).
-- Reszta aplikacji nie używa RLS/autoryzacji, więc dopasowujemy się
-- do istniejącego wzorca zamiast dodawać nowy model bezpieczeństwa.
--
-- Uwaga: crm_tender_portals.password_encrypted będzie po tym
-- czytelne przez anon key jako CIPHERTEXT — to celowo bezpieczne,
-- bo odszyfrowanie wymaga CRM_ENCRYPTION_KEY, który istnieje
-- wyłącznie po stronie serwera (src/lib/crmCrypto.ts).
-- ============================================================

alter table crm_contacts       disable row level security;
alter table crm_activities     disable row level security;
alter table crm_tender_portals disable row level security;

grant select, insert, update, delete on crm_contacts       to anon, authenticated;
grant select, insert, update, delete on crm_activities     to anon, authenticated;
grant select, insert, update, delete on crm_tender_portals to anon, authenticated;
