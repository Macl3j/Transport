-- ============================================================
-- TruckCalc HBM — Podwójna akceptacja płatności (/akceptacje)
-- Realizuje ustalenie z narady 15.09.2026: Hubert zgłasza płatność
-- (z rejestru kosztów albo ręcznie), Rafał (lub zastępca) zatwierdza
-- lub odrzuca z komentarzem, wyznaczeni obserwatorzy widzą historię.
--
-- W ODRÓŻNIENIU od reszty aplikacji (RLS "authenticated = wszystko
-- wolno") ten moduł pilnuje ról w bazie, nie tylko w interfejsie —
-- inaczej "podwójna akceptacja" nic by nie znaczyła: każdy zalogowany
-- mógłby sam sobie zatwierdzić własne zgłoszenie.
-- ============================================================

-- ─── ROLE: kto zgłasza / zatwierdza / tylko widzi historię ─────
-- Osobna tabela zamiast reguł na sztywno w kodzie — dopisanie/zmiana
-- osoby to jeden INSERT/DELETE w Supabase Studio, bez zmiany appki.
create table if not exists finance_approval_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('submitter', 'approver', 'viewer')),
  note       text,
  created_at timestamptz default now(),
  unique (user_id, role)
);

-- ─── ZGŁOSZENIA PŁATNOŚCI ───────────────────────────────────────
create table if not exists payment_approvals (
  id                uuid primary key default gen_random_uuid(),
  -- źródło: powiązanie z rejestrem kosztów (preferowane) albo ręczny wpis,
  -- gdy faktury jeszcze nie ma w cost_invoices (import bywa opóźniony)
  source            text not null check (source in ('rejestr', 'reczne')),
  cost_invoice_id   uuid references cost_invoices(id),
  vendor            text not null,
  amount_pln        numeric not null,
  title             text,
  due_date          date,
  notes             text,
  status            text not null default 'oczekuje' check (status in ('oczekuje', 'zatwierdzona', 'odrzucona')),
  submitted_by      uuid not null references auth.users(id),
  submitted_at      timestamptz not null default now(),
  decided_by        uuid references auth.users(id),
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- odrzucenie bez powodu nie jest dozwolone na poziomie bazy, nie tylko UI
  constraint decision_note_required_on_reject check (status <> 'odrzucona' or decision_note is not null)
);

create index if not exists idx_payment_approvals_status on payment_approvals(status);
create index if not exists idx_payment_approvals_submitted_by on payment_approvals(submitted_by);
create index if not exists idx_payment_approvals_cost_invoice on payment_approvals(cost_invoice_id);

-- ─── RLS: role z finance_approval_roles, nie samo "authenticated" ──
alter table finance_approval_roles enable row level security;
alter table payment_approvals      enable row level security;

drop policy if exists "finance_approval_roles_select" on finance_approval_roles;
create policy "finance_approval_roles_select" on finance_approval_roles
  for select to authenticated using (true);
-- brak polityk insert/update/delete dla authenticated — role zarządzane
-- ręcznie w Supabase Studio (jako właściciel bazy), nie z poziomu appki.

drop policy if exists "payment_approvals_select" on payment_approvals;
create policy "payment_approvals_select" on payment_approvals
  for select to authenticated using (
    exists (select 1 from finance_approval_roles fr where fr.user_id = auth.uid())
  );

drop policy if exists "payment_approvals_insert" on payment_approvals;
create policy "payment_approvals_insert" on payment_approvals
  for insert to authenticated with check (
    submitted_by = auth.uid()
    and exists (select 1 from finance_approval_roles fr where fr.user_id = auth.uid() and fr.role = 'submitter')
  );

-- Dwie osobne (permisywne, łączone przez OR) polityki update:
-- (1) zgłaszający może edytować własne zgłoszenie, dopóki czeka na decyzję
-- (2) zatwierdzający może zmienić status, dopóki zgłoszenie czeka na decyzję
drop policy if exists "payment_approvals_update_submitter" on payment_approvals;
create policy "payment_approvals_update_submitter" on payment_approvals
  for update to authenticated
  using (status = 'oczekuje' and submitted_by = auth.uid())
  with check (submitted_by = auth.uid());

drop policy if exists "payment_approvals_update_approver" on payment_approvals;
create policy "payment_approvals_update_approver" on payment_approvals
  for update to authenticated
  using (
    status = 'oczekuje'
    and exists (select 1 from finance_approval_roles fr where fr.user_id = auth.uid() and fr.role = 'approver')
  )
  with check (decided_by = auth.uid());

-- Wycofanie własnego zgłoszenia, dopóki nikt go nie rozpatrzył
drop policy if exists "payment_approvals_delete" on payment_approvals;
create policy "payment_approvals_delete" on payment_approvals
  for delete to authenticated using (status = 'oczekuje' and submitted_by = auth.uid());

revoke all on finance_approval_roles, payment_approvals from anon;
grant select on finance_approval_roles to authenticated;
grant select, insert, update, delete on payment_approvals to authenticated;

-- ─── Wstępne role wg ustaleń z narady: Hubert zgłasza, Rafał zatwierdza,
-- Maciej Witkowski jako zastępca zatwierdzającego, wszyscy czworo + Klaudiusz
-- widzą historię. Dopasuj e-maile, jeśli się różnią od tych w auth.users. ──
insert into finance_approval_roles (user_id, role, note)
select id, 'submitter', 'ustalenie z narady 15.09' from auth.users where email = 'hubert.d@bminvestgroup.eu'
union all
select id, 'approver', 'ustalenie z narady 15.09' from auth.users where email = 'rafal.swider@bminvestgroup.eu'
union all
select id, 'approver', 'zastępca na czas nieobecności Rafała' from auth.users where email = 'maciej.witkowski@bminvestgroup.eu'
union all
select id, 'viewer', null from auth.users where email in (
  'hubert.d@bminvestgroup.eu', 'rafal.swider@bminvestgroup.eu',
  'maciej.witkowski@bminvestgroup.eu', 'klaudiusz@banaszkiewicz-grupa.pl'
)
on conflict (user_id, role) do nothing;
