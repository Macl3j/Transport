-- ============================================================
-- TruckCalc HBM — Rozliczenia kierowców (/rozliczenia-kierowcow)
-- B&M liczy miesięczne wypłaty netto kierowców i wysyła zestawienie
-- do Ozar Trans (płatnik). Wzorzec: plik "wypłaty kierowcy <miesiąc>.ods"
-- (arkusz na kierowcę + RAZEM).
--
-- Dane wrażliwe (zarobki), więc — tak jak w 023_payment_approvals —
-- uprawnienia pilnuje BAZA, nie tylko interfejs:
--   editor   — wpisuje dni pracy / urlopu / chorobowego oraz uznania
--              i potrącenia. NIE widzi stawek ani sum wypłat.
--   approver — wszystko: osoby, stawki, zgłoszenie→zatwierdzenie→wysyłka.
-- Brak roli = brak dostępu do jakiejkolwiek tabeli modułu.
-- Role dopisuje się ręcznie w Supabase Studio (patrz koniec pliku).
--
-- Reguły, które w pliku .ods łatwo było złamać, są ograniczeniami bazy:
--   * potrącenie nie może być dodatnie, uznanie ujemne (błąd znaku),
--   * dni pracy + urlop + chorobowe <= liczba dni miesiąca,
--   * opis pozycji obowiązkowy, a potrącenie wymaga wpisanej podstawy,
--   * kwota PLN musi zgadzać się z kwotą w walucie × kurs.
-- Każda zmiana trafia do payroll_audit.
-- ============================================================

-- ─── ROLE ──────────────────────────────────────────────────────
create table if not exists payroll_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('editor', 'approver')),
  note       text,
  created_at timestamptz default now(),
  unique (user_id, role)
);

-- approver ma też uprawnienia editora
create or replace function public.payroll_has_role(r text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from payroll_roles
    where user_id = auth.uid()
      and (role = r or (r = 'editor' and role = 'approver'))
  );
$$;

-- ─── OSOBY (kierowcy rozliczani przez Ozar) ────────────────────
create table if not exists payroll_people (
  id          uuid primary key default gen_random_uuid(),
  first_name  text not null,
  last_name   text not null,
  -- nazwa arkusza z pliku historycznego — do dopasowania przy imporcie
  sheet_name  text unique,
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now()
);

-- ─── STAWKI (historia; tylko approver) ─────────────────────────
-- Stawka obowiązuje od pierwszego dnia miesiąca valid_from.
create table if not exists payroll_rates (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references payroll_people(id) on delete cascade,
  day_rate    numeric(10,2) not null check (day_rate >= 0),
  leave_rate  numeric(10,2) not null check (leave_rate >= 0),
  valid_from  date not null,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (person_id, valid_from),
  constraint rate_valid_from_first_day check (extract(day from valid_from) = 1)
);

-- ─── MIESIĄCE ──────────────────────────────────────────────────
create table if not exists payroll_periods (
  id           uuid primary key default gen_random_uuid(),
  year         int not null check (year between 2024 and 2100),
  month        int not null check (month between 1 and 12),
  status       text not null default 'otwarty'
               check (status in ('otwarty', 'zgloszony', 'zatwierdzony', 'wyslany')),
  version      int not null default 1,
  submitted_by uuid, submitted_at timestamptz,
  approved_by  uuid, approved_at  timestamptz,
  sent_by      uuid, sent_at      timestamptz,
  note         text,
  created_at   timestamptz not null default now(),
  unique (year, month)
);

create or replace function public.payroll_period_status(pid uuid)
returns text
language sql stable security definer set search_path = public
as $$ select status from payroll_periods where id = pid; $$;

-- ─── DNI (wpisuje editor) ──────────────────────────────────────
create table if not exists payroll_lines (
  id           uuid primary key default gen_random_uuid(),
  period_id    uuid not null references payroll_periods(id) on delete cascade,
  person_id    uuid not null references payroll_people(id),
  days_worked  int not null default 0 check (days_worked >= 0),
  days_leave   int not null default 0 check (days_leave >= 0),
  days_sick    int not null default 0 check (days_sick >= 0),
  note         text,
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  unique (period_id, person_id)
);

create or replace function public.payroll_check_line()
returns trigger
language plpgsql
as $$
declare y int; m int; dim int;
begin
  select year, month into y, m from payroll_periods where id = new.period_id;
  dim := extract(day from ((make_date(y, m, 1) + interval '1 month')::date - 1));
  if new.days_worked + new.days_leave + new.days_sick > dim then
    raise exception 'Suma dni (%) przekracza liczbę dni miesiąca (%).',
      new.days_worked + new.days_leave + new.days_sick, dim;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
drop trigger if exists payroll_lines_check on payroll_lines;
create trigger payroll_lines_check before insert or update on payroll_lines
  for each row execute procedure public.payroll_check_line();

-- ─── UZNANIA I POTRĄCENIA (pozycje rozbite na linie) ───────────
-- amount_orig = wartość bezwzględna w walucie, amount_pln ze znakiem:
-- uznanie >= 0, potrącenie <= 0.
create table if not exists payroll_entries (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid not null references payroll_periods(id) on delete cascade,
  person_id   uuid not null references payroll_people(id),
  kind        text not null check (kind in ('credit', 'deduction')),
  category    text not null,
  description text not null check (length(trim(description)) > 0),
  basis       text,
  currency    text not null default 'PLN' check (currency in ('PLN', 'EUR')),
  amount_orig numeric(12,2) not null check (amount_orig >= 0),
  fx_rate     numeric(10,4) not null default 1 check (fx_rate > 0),
  amount_pln  numeric(12,2) not null,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  constraint entry_sign check (
    (kind = 'credit' and amount_pln >= 0) or (kind = 'deduction' and amount_pln <= 0)
  ),
  constraint entry_pln_matches check (
    abs(abs(amount_pln) - round(amount_orig * fx_rate, 2)) < 0.011
  ),
  constraint entry_deduction_basis check (
    kind = 'credit' or length(trim(coalesce(basis, ''))) > 0
  )
);
create index if not exists idx_payroll_entries_period on payroll_entries(period_id, person_id);

-- ─── STAWKI ZAMROŻONE PRZY ZATWIERDZENIU (tylko approver) ──────
create table if not exists payroll_period_rates (
  period_id  uuid not null references payroll_periods(id) on delete cascade,
  person_id  uuid not null references payroll_people(id),
  day_rate   numeric(10,2) not null,
  leave_rate numeric(10,2) not null,
  primary key (period_id, person_id)
);

-- ─── DZIENNIK ZMIAN ────────────────────────────────────────────
create table if not exists payroll_audit (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  table_name text not null,
  row_id     text,
  action     text not null,
  old_row    jsonb,
  new_row    jsonb
);
create index if not exists idx_payroll_audit_at on payroll_audit(at desc);

create or replace function public.payroll_audit_fn()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare j jsonb;
begin
  j := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  insert into payroll_audit (user_id, table_name, row_id, action, old_row, new_row)
  values (auth.uid(), tg_table_name,
          coalesce(j->>'id', (j->>'period_id') || '/' || (j->>'person_id')),
          tg_op,
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['payroll_people', 'payroll_rates', 'payroll_periods',
                           'payroll_lines', 'payroll_entries', 'payroll_period_rates']
  loop
    execute format('drop trigger if exists %I on %I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on %I
                    for each row execute procedure public.payroll_audit_fn()', t || '_audit', t);
  end loop;
end $$;

-- ─── RLS ───────────────────────────────────────────────────────
alter table payroll_roles        enable row level security;
alter table payroll_people       enable row level security;
alter table payroll_rates        enable row level security;
alter table payroll_periods      enable row level security;
alter table payroll_lines        enable row level security;
alter table payroll_entries      enable row level security;
alter table payroll_period_rates enable row level security;
alter table payroll_audit        enable row level security;

-- role: każdy widzi własne, approver widzi wszystkie; zarządzanie w Studio
drop policy if exists payroll_roles_select on payroll_roles;
create policy payroll_roles_select on payroll_roles for select to authenticated
  using (user_id = auth.uid() or public.payroll_has_role('approver'));

-- osoby: odczyt editor+, zapis approver
drop policy if exists payroll_people_select on payroll_people;
create policy payroll_people_select on payroll_people for select to authenticated
  using (public.payroll_has_role('editor'));
drop policy if exists payroll_people_write on payroll_people;
create policy payroll_people_write on payroll_people for all to authenticated
  using (public.payroll_has_role('approver')) with check (public.payroll_has_role('approver'));

-- stawki i zamrożone stawki: tylko approver
drop policy if exists payroll_rates_all on payroll_rates;
create policy payroll_rates_all on payroll_rates for all to authenticated
  using (public.payroll_has_role('approver')) with check (public.payroll_has_role('approver'));
drop policy if exists payroll_period_rates_all on payroll_period_rates;
create policy payroll_period_rates_all on payroll_period_rates for all to authenticated
  using (public.payroll_has_role('approver')) with check (public.payroll_has_role('approver'));

-- miesiące: odczyt editor+; otwiera approver; editor może tylko zgłosić (otwarty → zgłoszony)
drop policy if exists payroll_periods_select on payroll_periods;
create policy payroll_periods_select on payroll_periods for select to authenticated
  using (public.payroll_has_role('editor'));
drop policy if exists payroll_periods_insert on payroll_periods;
create policy payroll_periods_insert on payroll_periods for insert to authenticated
  with check (public.payroll_has_role('approver') and status = 'otwarty');
drop policy if exists payroll_periods_update_approver on payroll_periods;
create policy payroll_periods_update_approver on payroll_periods for update to authenticated
  using (public.payroll_has_role('approver')) with check (public.payroll_has_role('approver'));
drop policy if exists payroll_periods_update_editor on payroll_periods;
create policy payroll_periods_update_editor on payroll_periods for update to authenticated
  using (status = 'otwarty' and public.payroll_has_role('editor'))
  with check (status in ('otwarty', 'zgloszony'));

-- dni i pozycje: odczyt editor+; zapis editor gdy miesiąc otwarty,
-- approver także gdy zgłoszony (poprawki przed zatwierdzeniem)
drop policy if exists payroll_lines_select on payroll_lines;
create policy payroll_lines_select on payroll_lines for select to authenticated
  using (public.payroll_has_role('editor'));
drop policy if exists payroll_lines_write on payroll_lines;
create policy payroll_lines_write on payroll_lines for all to authenticated
  using (
    (public.payroll_period_status(period_id) = 'otwarty' and public.payroll_has_role('editor'))
    or (public.payroll_period_status(period_id) = 'zgloszony' and public.payroll_has_role('approver'))
  )
  with check (
    (public.payroll_period_status(period_id) = 'otwarty' and public.payroll_has_role('editor'))
    or (public.payroll_period_status(period_id) = 'zgloszony' and public.payroll_has_role('approver'))
  );

drop policy if exists payroll_entries_select on payroll_entries;
create policy payroll_entries_select on payroll_entries for select to authenticated
  using (public.payroll_has_role('editor'));
drop policy if exists payroll_entries_write on payroll_entries;
create policy payroll_entries_write on payroll_entries for all to authenticated
  using (
    (public.payroll_period_status(period_id) = 'otwarty' and public.payroll_has_role('editor'))
    or (public.payroll_period_status(period_id) = 'zgloszony' and public.payroll_has_role('approver'))
  )
  with check (
    (public.payroll_period_status(period_id) = 'otwarty' and public.payroll_has_role('editor'))
    or (public.payroll_period_status(period_id) = 'zgloszony' and public.payroll_has_role('approver'))
  );

drop policy if exists payroll_audit_select on payroll_audit;
create policy payroll_audit_select on payroll_audit for select to authenticated
  using (public.payroll_has_role('approver'));

-- ─── UPRAWNIENIA (jawne GRANT-y — Data API nie nadaje ich już domyślnie) ──
revoke all on payroll_roles, payroll_people, payroll_rates, payroll_periods, payroll_lines,
              payroll_entries, payroll_period_rates, payroll_audit from anon;
grant select on payroll_roles, payroll_audit to authenticated;
grant select, insert, update, delete on payroll_people, payroll_rates, payroll_periods,
              payroll_lines, payroll_entries, payroll_period_rates to authenticated;
revoke delete on payroll_periods from authenticated;
grant execute on function public.payroll_has_role(text) to authenticated;
grant execute on function public.payroll_period_status(uuid) to authenticated;

-- ─── ROLE STARTOWE — świadomie NIE nadaję nikomu automatycznie ──
-- Dopisz w Supabase Studio po sprawdzeniu adresów w auth.users, np.:
--   insert into payroll_roles (user_id, role, note)
--   select id, 'approver', 'zatwierdza zestawienie dla Ozar'
--   from auth.users where email = '...';
--   insert into payroll_roles (user_id, role, note)
--   select id, 'editor', 'wpisuje dni, urlopy i potrącenia'
--   from auth.users where email in ('...', '...');
