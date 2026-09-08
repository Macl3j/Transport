-- Zasieg floty na mapie CRM: pokazuje handlowcowi miejsca zaladunku/rozladunku
-- z historii tras (route_history), zeby mogl szukac nowych klientow w
-- obszarach, ktore flota juz i tak obsluguje.
--
-- city_coordinates: geokodowanie miast jednorazowe (klucz city+country), zeby
-- nie odpytywac Nominatim za kazdym razem -- flota jezdzi powtarzalnie do tych
-- samych miejscowosci wiec liczba unikalnych miast jest dużo mniejsza niz
-- liczba zlecen.
create table if not exists city_coordinates (
  city         text not null,
  country      text not null,
  lat          double precision,
  lng          double precision,
  geocoded_at  timestamptz,
  primary key (city, country)
);

-- route_visit_log: kazdy zaladunek i rozladunek jako osobny "odwiedziny" tego
-- miasta -- widok (nie tabela), zeby zawsze byl zgodny z aktualna zawartoscia
-- route_history bez potrzeby recznego odswiezania po kazdym imporcie XLS.
-- Filtrowanie po okresie (np. "ostatnie 12 mies.") robione po stronie klienta
-- na tym surowym logu, zeby uniknac mnożenia widokow per okres.
create or replace view route_visit_log as
select origin_city as city, origin_country as country, pickup_date as visit_date
from route_history
where origin_city is not null and origin_country is not null
union all
select dest_city as city, dest_country as country, delivery_date as visit_date
from route_history
where dest_city is not null and dest_country is not null;
