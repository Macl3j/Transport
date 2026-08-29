-- Tygodniowa cena referencyjna ON (Pmed, MMA >= 7 500 kg) do liczenia korekty
-- paliwowej. Zasilana przez upload w /korekty-paliwowe (oficjalny plik
-- Ministerio de Transportes) — nadpisuje/rozszerza dane wbudowane w kod.
create table if not exists fuel_price_series (
  date_serial  integer primary key,   -- data (serial Excela) początku tygodnia
  price_ge75t  numeric(10,6) not null, -- Pmed €/L dla MMA >= 7 500 kg
  updated_at   timestamptz default now()
);
