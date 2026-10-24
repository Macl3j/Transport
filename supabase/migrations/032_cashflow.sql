-- ============================================================
-- TruckCalc HBM — Cashflow (/cashflow)
-- Tygodniowy plan wpływów i wypłat z faktur: ile faktur, kiedy i na jaką
-- kwotę trzeba zapłacić oraz ile wpłynie wg terminów płatności.
--
-- 1) cost_invoices.odbiorca — rejestr kosztów ma kolumnę "Odbiorca" (B&M
--    albo KRAVTT). KRAVTT to odrębna spółka i jej faktur nie wolno liczyć
--    jako zobowiązań B&M; bez tej kolumny nie dało się ich odfiltrować
--    (w rejestrze z 17.10.2026: 149 z 511 otwartych faktur).
-- 2) receivable_invoices — otwarte i zapłacone faktury sprzedażowe z
--    terminem płatności, kwotą pozostałą do zapłaty i oznaczeniem faktora
--    (IFIS). Dotychczasowa revenue_records nie ma terminów płatności.
--    Import robi upsert po numerze faktury, więc kolejne eksporty (także
--    częściowe, np. sam bieżący miesiąc) uzupełniają i aktualizują dane.
-- ============================================================

alter table cost_invoices add column if not exists odbiorca text;

create table if not exists receivable_invoices (
  id                uuid primary key default gen_random_uuid(),
  numer             text not null unique,
  typ               text,
  data_wystawienia  date,
  termin_platnosci  date,
  kontrahent        text,
  brutto_pln        numeric,
  pozostalo_pln     numeric,
  status_platnosci  text,
  faktor            text,        -- np. 'IFIS' (faktura sfinansowana przez faktora), null = bez faktora
  firma             text,
  imported_at       timestamptz not null default now()
);

create index if not exists receivable_invoices_termin_idx on receivable_invoices (termin_platnosci);
create index if not exists receivable_invoices_open_idx   on receivable_invoices (pozostalo_pln) where pozostalo_pln > 0;

-- Dane finansowe: tylko zalogowani (strona /cashflow ma bramkę logowania).
alter table receivable_invoices enable row level security;
drop policy if exists receivable_invoices_all on receivable_invoices;
create policy receivable_invoices_all on receivable_invoices
  for all to authenticated using (true) with check (true);

revoke all on receivable_invoices from anon;
grant select, insert, update, delete on receivable_invoices to authenticated;
