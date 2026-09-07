-- route_calculations ma wlaczone RLS bez zadnej polityki dla klucza anon,
-- wiec zapis kalkulacji z /kalkulator byl po cichu odrzucany (42501) - Historia
-- swiecila pustka mimo klikania "Zapisz kalkulacje". Reszta tabel w tej
-- aplikacji dziala bez RLS (single-tenant, wewnetrzne narzedzie) - ta sama
-- konwencja co przy fuel_price_series (013) i cost_invoices.

alter table route_calculations disable row level security;
