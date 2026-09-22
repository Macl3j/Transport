-- ============================================================
-- TruckCalc HBM — Zamawianie części warsztatowych (/serwis/zamowienia)
-- Osobny system od finance_approval_roles/payment_approvals (migracja 023) —
-- inne osoby, inny kanał Teams, inna domena. Kacper zgłasza zapotrzebowanie
-- na część, Chytrowski lub Rafał (Maciej Witkowski jako dodatkowy zastępca)
-- zatwierdza albo odrzuca z komentarzem.
--
-- W ODRÓŻNIENIU od reszty /serwis (bez logowania) TA podstrona wymaga
-- konta — inaczej "kto zgłosił / kto zatwierdził" nie miałoby sensu.
-- Reszta /serwis (kartoteka, historia) zostaje bez zmian, bez logowania.
-- ============================================================

-- ─── ROLE: kto zgłasza / zatwierdza / tylko widzi historię ─────
create table if not exists part_order_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('submitter', 'approver', 'viewer')),
  note       text,
  created_at timestamptz default now(),
  unique (user_id, role)
);

-- ─── ZAMÓWIENIA CZĘŚCI ───────────────────────────────────────────
create table if not exists part_orders (
  id                uuid primary key default gen_random_uuid(),
  part_name         text not null,
  part_number       text,                        -- nr katalogowy, opcjonalnie
  quantity          numeric not null default 1,
  vehicle_reg       text,                        -- opcjonalne — do konkretnej naprawy albo NULL (zamówienie ogólne)
  estimated_cost_pln numeric,
  vendor            text,                        -- opcjonalny dostawca
  notes             text,
  status            text not null default 'oczekuje' check (status in ('oczekuje', 'zatwierdzona', 'odrzucona')),
  submitted_by      uuid not null references auth.users(id),
  submitted_at      timestamptz not null default now(),
  decided_by        uuid references auth.users(id),
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint decision_note_required_on_reject check (status <> 'odrzucona' or decision_note is not null)
);

create index if not exists idx_part_orders_status on part_orders(status);
create index if not exists idx_part_orders_submitted_by on part_orders(submitted_by);
create index if not exists idx_part_orders_vehicle_reg on part_orders(vehicle_reg);

-- ─── RLS: role z part_order_roles, nie samo "authenticated" ────
alter table part_order_roles enable row level security;
alter table part_orders      enable row level security;

drop policy if exists "part_order_roles_select" on part_order_roles;
create policy "part_order_roles_select" on part_order_roles
  for select to authenticated using (true);

drop policy if exists "part_orders_select" on part_orders;
create policy "part_orders_select" on part_orders
  for select to authenticated using (
    exists (select 1 from part_order_roles pr where pr.user_id = auth.uid())
  );

drop policy if exists "part_orders_insert" on part_orders;
create policy "part_orders_insert" on part_orders
  for insert to authenticated with check (
    submitted_by = auth.uid()
    and exists (select 1 from part_order_roles pr where pr.user_id = auth.uid() and pr.role = 'submitter')
  );

drop policy if exists "part_orders_update_submitter" on part_orders;
create policy "part_orders_update_submitter" on part_orders
  for update to authenticated
  using (status = 'oczekuje' and submitted_by = auth.uid())
  with check (submitted_by = auth.uid());

drop policy if exists "part_orders_update_approver" on part_orders;
create policy "part_orders_update_approver" on part_orders
  for update to authenticated
  using (
    status = 'oczekuje'
    and exists (select 1 from part_order_roles pr where pr.user_id = auth.uid() and pr.role = 'approver')
  )
  with check (decided_by = auth.uid());

drop policy if exists "part_orders_delete" on part_orders;
create policy "part_orders_delete" on part_orders
  for delete to authenticated using (status = 'oczekuje' and submitted_by = auth.uid());

revoke all on part_order_roles, part_orders from anon;
grant select on part_order_roles to authenticated;
grant select, insert, update, delete on part_orders to authenticated;

-- ─── Wstępne role: Kacper zgłasza; Chytrowski, Rafał i Maciej Witkowski
-- (zastępca) zatwierdzają; ci sami + Kacper widzą historię. Uruchom TYLKO
-- po założeniu konta kacper.b@bminvestgroup.eu w Supabase Studio — bez
-- tego poniższy insert nic nie doda (auth.users nie będzie miał pasującego
-- e-maila) i trzeba go odpalić ponownie po założeniu konta. ─────────────
insert into part_order_roles (user_id, role, note)
select id, 'submitter', 'zgłasza zapotrzebowanie na części' from auth.users where email = 'kacper.b@bminvestgroup.eu'
union all
select id, 'approver', null from auth.users where email = 'maciej.ch@bminvestgroup.eu'
union all
select id, 'approver', null from auth.users where email = 'rafal.swider@bminvestgroup.eu'
union all
select id, 'approver', 'dodatkowy zastępca' from auth.users where email = 'maciej.witkowski@bminvestgroup.eu'
union all
select id, 'viewer', null from auth.users where email in (
  'kacper.b@bminvestgroup.eu', 'maciej.ch@bminvestgroup.eu',
  'rafal.swider@bminvestgroup.eu', 'maciej.witkowski@bminvestgroup.eu'
)
on conflict (user_id, role) do nothing;
