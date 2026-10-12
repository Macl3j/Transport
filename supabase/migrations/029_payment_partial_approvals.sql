-- ============================================================
-- TruckCalc HBM — Cząstkowa akceptacja płatności (/akceptacje)
--
-- Pozwala zatwierdzającemu na akceptację częściową wydatku:
-- - rejestracja wpisów w payment_partial_approvals (kwota, data, uwaga, kto zaakceptował)
-- - status 'czesciowo_zaakceptowana' w payment_approvals
-- - pozycja nie znika z listy oczekujących / do zatwierdzenia, dopóki
--   suma zaakceptowanych kwot nie osiągnie pierwotnej kwoty wydatku
-- ============================================================

-- 1. Aktualizacja check constraint na status w payment_approvals
alter table payment_approvals
  drop constraint if exists payment_approvals_status_check;

alter table payment_approvals
  add constraint payment_approvals_status_check
  check (status in ('oczekuje', 'czesciowo_zaakceptowana', 'zatwierdzona', 'odrzucona'));

-- 2. Tabela cząstkowych akceptacji
create table if not exists payment_partial_approvals (
  id                  uuid primary key default gen_random_uuid(),
  payment_approval_id uuid not null references payment_approvals(id) on delete cascade,
  amount_pln          numeric not null check (amount_pln > 0),
  note                text,
  decided_by          uuid not null references auth.users(id),
  created_at          timestamptz not null default now()
);

create index if not exists idx_payment_partial_approvals_approval_id
  on payment_partial_approvals(payment_approval_id);

-- 3. RLS dla payment_partial_approvals
alter table payment_partial_approvals enable row level security;

-- Wszyscy uprawnieni do modułu akceptacji widzą wpisy cząstkowe
drop policy if exists "payment_partial_approvals_select" on payment_partial_approvals;
create policy "payment_partial_approvals_select" on payment_partial_approvals
  for select to authenticated using (
    exists (select 1 from finance_approval_roles fr where fr.user_id = auth.uid())
  );

-- Zatwierdzający mogą dodawać wpisy cząstkowe
drop policy if exists "payment_partial_approvals_insert" on payment_partial_approvals;
create policy "payment_partial_approvals_insert" on payment_partial_approvals
  for insert to authenticated with check (
    decided_by = auth.uid()
    and exists (select 1 from finance_approval_roles fr where fr.user_id = auth.uid() and fr.role = 'approver')
  );

-- Uprawnienia
revoke all on payment_partial_approvals from anon;
grant select, insert on payment_partial_approvals to authenticated;

-- 4. Aktualizacja uprawnień UPDATE w payment_approvals dla approvera
-- Approver musi móc zmienić status także gdy pozycja ma status 'czesciowo_zaakceptowana'
drop policy if exists "payment_approvals_update_approver" on payment_approvals;
create policy "payment_approvals_update_approver" on payment_approvals
  for update to authenticated
  using (
    status in ('oczekuje', 'czesciowo_zaakceptowana')
    and exists (select 1 from finance_approval_roles fr where fr.user_id = auth.uid() and fr.role = 'approver')
  )
  with check (decided_by = auth.uid());
