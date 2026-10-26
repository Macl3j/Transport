-- ============================================================
-- TruckCalc HBM — salda kont (/cashflow)
-- Stan gotówki na dziś to suma sald kilku rachunków (mBank PLN, mBank EUR, PKO,
-- ING…). Każdy zapis salda to nowy wiersz (historia), a strona bierze najnowszy
-- zapis dla każdego konta. Salda w EUR są przeliczane po kursie ustawianym na stronie.
-- ============================================================

create table if not exists cash_balances (
  id          uuid primary key default gen_random_uuid(),
  account     text not null check (length(trim(account)) > 0),
  currency    text not null check (currency in ('PLN', 'EUR')),
  amount      numeric(14,2) not null,        -- może być ujemne (debet na rachunku)
  as_of       date not null default current_date,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists cash_balances_account_idx on cash_balances (account, as_of desc, created_at desc);

-- Dane finansowe: tylko zalogowani. Bez UPDATE — poprawka salda to nowy zapis albo usunięcie błędnego.
alter table cash_balances enable row level security;
drop policy if exists cash_balances_all on cash_balances;
create policy cash_balances_all on cash_balances for all to authenticated using (true) with check (true);

revoke all on cash_balances from anon;
grant select, insert, delete on cash_balances to authenticated;
