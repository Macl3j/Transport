-- ============================================================
-- Wymuś potwierdzenie braku towaru na magazynie warsztatu przed
-- zgłoszeniem zamówienia części (/serwis/zamowienia) — zapobiega
-- zamawianiu czegoś, co już leży na półce.
-- ============================================================

alter table part_orders
  add column if not exists stock_checked boolean not null default false;

-- Tabela była pusta w chwili pisania tej migracji, ale na wszelki wypadek:
-- istniejące zamówienia (zgłoszone przed tą zmianą) też oznaczamy jako
-- zweryfikowane, żeby poniższy constraint nie odrzucił ich retroaktywnie.
update part_orders set stock_checked = true where stock_checked = false;

alter table part_orders
  drop constraint if exists stock_checked_required;
alter table part_orders
  add constraint stock_checked_required check (stock_checked = true);
