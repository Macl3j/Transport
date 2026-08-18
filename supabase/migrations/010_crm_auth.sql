-- ============================================================
-- TruckCalc HBM — CRM: logowanie (Supabase Auth) + atrybucja + RLS
-- Pierwsza tabela w projekcie z realną autoryzacją — reszta aplikacji
-- świadomie zostaje bez logowania (patrz notatka w migracji 009).
-- ============================================================

create extension if not exists "uuid-ossp";

-- ─── PROFILE (czytelna nazwa dla auth.users) ───────────────────
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz default now()
);

-- Auto-tworzenie profilu przy założeniu konta (invite / signup)
create or replace function public.handle_new_crm_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_crm on auth.users;
create trigger on_auth_user_created_crm
  after insert on auth.users
  for each row execute procedure public.handle_new_crm_user();

-- ─── ATRYBUCJA: kto dodał kontrahenta ──────────────────────────
alter table crm_contacts add column if not exists created_by uuid references auth.users(id);

-- ─── RLS: tylko zalogowani (authenticated), reszta appki bez zmian ──
-- Migracja 009 celowo wyłączyła RLS, bo appka nie miała logowania —
-- teraz logowanie istnieje, więc RLS zaczyna mieć realny sens.
alter table crm_contacts       enable row level security;
alter table crm_activities     enable row level security;
alter table crm_tender_portals enable row level security;
alter table profiles           enable row level security;

drop policy if exists "crm_contacts_authenticated"       on crm_contacts;
drop policy if exists "crm_activities_authenticated"     on crm_activities;
drop policy if exists "crm_tender_portals_authenticated" on crm_tender_portals;
drop policy if exists "profiles_read_authenticated"      on profiles;

create policy "crm_contacts_authenticated" on crm_contacts
  for all to authenticated using (true) with check (true);
create policy "crm_activities_authenticated" on crm_activities
  for all to authenticated using (true) with check (true);
create policy "crm_tender_portals_authenticated" on crm_tender_portals
  for all to authenticated using (true) with check (true);
create policy "profiles_read_authenticated" on profiles
  for select to authenticated using (true);

-- Domknięcie: klucz anon (widoczny w kodzie klienta) traci wszelki dostęp
-- do tabel CRM — bez ważnej sesji logowania żadna polityka go nie obejmuje.
revoke all on crm_contacts, crm_activities, crm_tender_portals, profiles from anon;
grant select, insert, update, delete on crm_contacts, crm_activities, crm_tender_portals to authenticated;
grant select on profiles to authenticated;
