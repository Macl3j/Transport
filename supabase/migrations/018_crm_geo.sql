-- Wspolrzedne geograficzne kontaktow CRM pod mape klientow.
-- Wypelniane geokodowaniem adresu/miasta (OpenStreetMap Nominatim), jednorazowo
-- w skrypcie backfill + na zadanie po edycji adresu -- nie liczone na zywo przy
-- kazdym wejsciu na mape.

alter table crm_contacts add column if not exists lat double precision;
alter table crm_contacts add column if not exists lng double precision;
