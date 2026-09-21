-- ============================================================
-- TruckCalc HBM — Sprzedaż części z wycofanych pojazdów (/czesci)
-- Ten sam model dostępu co CRM handlowy i /windykacja: tylko
-- zalogowani (authenticated).
-- ============================================================

create extension if not exists "uuid-ossp";

-- ─── ROZBIÓRKA / SPRZEDAŻ POJAZDU (jeden wpis na pojazd) ───────
create table if not exists dismantle_jobs (
  id                  uuid primary key default uuid_generate_v4(),
  vehicle_reg         text not null unique,
  status              text default 'planowana',     -- 'planowana' | 'w_toku' | 'zakonczona'
  ownership_status    text default 'nieznany',      -- 'nieznany' | 'leasing_aktywny' | 'wykupiony' | 'wlasny'
  planned_date        date,
  done_date           date,
  supervisor          text,
  estimated_value_pln numeric,                       -- kosztorys: ile spodziewamy się uzyskać
  notes               text,
  created_by          uuid references profiles(id),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- ─── CZĘŚCI ─────────────────────────────────────────────────────
create table if not exists vehicle_parts (
  id               uuid primary key default uuid_generate_v4(),
  vehicle_reg      text not null,
  category         text default 'reszta',      -- 'silnik' | 'skrzynia' | 'most' | 'kabina' | 'kola_opony' | 'elektronika' | 'caly_pojazd' | 'reszta'
  name             text not null,
  spec             text,                        -- nr silnika, moc, przebieg, stan techniczny
  asking_price_pln numeric,
  min_price_pln    numeric,
  status           text default 'do_zdemontowania', -- 'do_zdemontowania' | 'na_magazynie' | 'wystawiona' | 'zarezerwowana' | 'sprzedana' | 'zlomowana'
  location         text,                        -- plac / magazyn
  notes            text,
  created_by       uuid references profiles(id),
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- ─── SPRZEDAŻE ──────────────────────────────────────────────────
create table if not exists part_sales (
  id               uuid primary key default uuid_generate_v4(),
  part_id          uuid not null references vehicle_parts(id) on delete cascade,
  buyer            text,
  sale_price_pln   numeric not null default 0,
  sale_date        date not null default current_date,
  invoice_no       text,
  payment_status   text default 'oczekuje',     -- 'oczekuje' | 'zaplacone'
  created_by       uuid references profiles(id),
  created_at       timestamptz default now()
);

-- Sprzedaż automatycznie oznacza część jako sprzedaną
create or replace function public.handle_new_part_sale()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update vehicle_parts set status = 'sprzedana', updated_at = now() where id = new.part_id;
  return new;
end;
$$;

drop trigger if exists on_part_sale_created on part_sales;
create trigger on_part_sale_created
  after insert on part_sales
  for each row execute procedure public.handle_new_part_sale();

create index if not exists idx_vehicle_parts_reg    on vehicle_parts(vehicle_reg);
create index if not exists idx_vehicle_parts_status on vehicle_parts(status);
create index if not exists idx_part_sales_part      on part_sales(part_id);

-- ─── RLS: tylko authenticated ───────────────────────────────────
alter table dismantle_jobs enable row level security;
alter table vehicle_parts  enable row level security;
alter table part_sales     enable row level security;

drop policy if exists "dismantle_jobs_authenticated" on dismantle_jobs;
drop policy if exists "vehicle_parts_authenticated"  on vehicle_parts;
drop policy if exists "part_sales_authenticated"     on part_sales;

create policy "dismantle_jobs_authenticated" on dismantle_jobs
  for all to authenticated using (true) with check (true);
create policy "vehicle_parts_authenticated" on vehicle_parts
  for all to authenticated using (true) with check (true);
create policy "part_sales_authenticated" on part_sales
  for all to authenticated using (true) with check (true);

revoke all on dismantle_jobs, vehicle_parts, part_sales from anon;
grant select, insert, update, delete on dismantle_jobs, vehicle_parts, part_sales to authenticated;
