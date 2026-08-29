-- fuel_price_series miala domyslnie wlaczone RLS bez zadnej polityki, co
-- blokowalo zapis (upsert) z poziomu przegladarki kluczem anon. Pozostale
-- tabele floty (vehicles, maintenance, tires...) dzialaja bez RLS - ta sama
-- konwencja tutaj.
alter table fuel_price_series disable row level security;
