-- ============================================================
-- TruckCalc HBM — Śledzenie negocjacji z wierzycielami (windykacja/zaległości)
-- Ten sam model dostępu co CRM handlowy (migracja 010): tylko
-- zalogowani (authenticated) użytkownicy z tabeli profiles —
-- Rafał, Klaudiusz, Maciej Witkowski, Hubert i pozostali z profiles.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ─── WIERZYCIELE ────────────────────────────────────────────────
create table if not exists creditors (
  id                uuid primary key default uuid_generate_v4(),
  name              text not null,
  category          text default 'inne',        -- 'leasing' | 'kredyt' | 'dostawca' | 'wynagrodzenia' | 'inne'
  total_amount_pln  numeric not null default 0,
  status            text default 'otwarte',      -- 'otwarte' | 'w_negocjacji' | 'czesciowo_splacone' | 'splacone' | 'eskalacja_windykacja'
  original_due_date date,
  contract_terminated boolean default false,      -- umowa formalnie wypowiedziana
  assigned_to       uuid references profiles(id), -- kto prowadzi negocjacje
  next_action_date  date,                          -- denormalizowane z ostatniego zdarzenia — szybkie sortowanie/alert
  notes             text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- ─── KONTAKTY U WIERZYCIELA ─────────────────────────────────────
create table if not exists creditor_contacts (
  id           uuid primary key default uuid_generate_v4(),
  creditor_id  uuid not null references creditors(id) on delete cascade,
  name         text,
  role         text,     -- np. "opiekun klienta", "dział windykacji"
  phone        text,
  email        text,
  notes        text,
  created_at   timestamptz default now()
);

-- ─── HISTORIA NEGOCJACJI / ZDARZEŃ ──────────────────────────────
create table if not exists creditor_events (
  id                uuid primary key default uuid_generate_v4(),
  creditor_id       uuid not null references creditors(id) on delete cascade,
  event_type        text not null default 'note',  -- 'call' | 'email' | 'meeting' | 'payment' | 'status_change' | 'note'
  event_date        date not null default current_date,
  description       text,
  amount_pln        numeric,          -- kwota przy zdarzeniu typu 'payment'
  status_after      text,             -- nowy status po tym zdarzeniu, jeśli event_type = 'status_change'
  next_action_date  date,             -- jeśli ustawione → aktualizuje creditors.next_action_date (trigger niżej)
  created_by        uuid references profiles(id),
  created_at        timestamptz default now()
);

-- ─── AUTO-AKTUALIZACJA creditors.next_action_date / updated_at przy nowym zdarzeniu ──
create or replace function public.handle_new_creditor_event()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update creditors
  set next_action_date = coalesce(new.next_action_date, next_action_date),
      status            = coalesce(new.status_after, status),
      updated_at        = now()
  where id = new.creditor_id;
  return new;
end;
$$;

drop trigger if exists on_creditor_event_created on creditor_events;
create trigger on_creditor_event_created
  after insert on creditor_events
  for each row execute procedure public.handle_new_creditor_event();

create index if not exists idx_creditors_status            on creditors(status);
create index if not exists idx_creditors_next_action       on creditors(next_action_date);
create index if not exists idx_creditor_contacts_creditor  on creditor_contacts(creditor_id);
create index if not exists idx_creditor_events_creditor    on creditor_events(creditor_id, event_date desc);

-- ─── RLS: ten sam model co CRM handlowy (migracja 010) — tylko authenticated ──
alter table creditors         enable row level security;
alter table creditor_contacts enable row level security;
alter table creditor_events   enable row level security;

drop policy if exists "creditors_authenticated"         on creditors;
drop policy if exists "creditor_contacts_authenticated" on creditor_contacts;
drop policy if exists "creditor_events_authenticated"   on creditor_events;

create policy "creditors_authenticated" on creditors
  for all to authenticated using (true) with check (true);
create policy "creditor_contacts_authenticated" on creditor_contacts
  for all to authenticated using (true) with check (true);
create policy "creditor_events_authenticated" on creditor_events
  for all to authenticated using (true) with check (true);

revoke all on creditors, creditor_contacts, creditor_events from anon;
grant select, insert, update, delete on creditors, creditor_contacts, creditor_events to authenticated;
