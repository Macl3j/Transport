-- Moduł "Płatności" — kalkulator wymagalności płatności kosztowych.
-- Import pełnego eksportu faktur kosztowych (system FK), na jego bazie liczymy
-- realną historię opóźnień płatności per dostawca/kategoria ("maksymalne
-- bezpieczne przeciągnięcie") oraz priorytet płatności dla aktualnie
-- nierozliczonych faktur.

create table if not exists cost_invoices (
  id                 uuid primary key default gen_random_uuid(),
  numer              text,
  sprzedawca         text,
  typ_kosztu         text,
  status_splaty      text,
  data_wystawienia   date,
  termin_platnosci   date,
  data_zaplaty       date,
  brutto_pln         numeric,
  pozostalo_do_zaplaty_pln numeric,
  pojazd_reg         text,
  kraj_sprzedawcy    text,
  raw                jsonb,
  imported_at        timestamptz not null default now()
);

create index if not exists cost_invoices_sprzedawca_idx on cost_invoices (sprzedawca);
create index if not exists cost_invoices_typ_kosztu_idx  on cost_invoices (typ_kosztu);
create index if not exists cost_invoices_termin_idx      on cost_invoices (termin_platnosci);

alter table cost_invoices disable row level security;
