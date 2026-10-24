-- Role startowe modułu "Rozliczenia kierowców" — uruchom RAZ w Supabase Studio
-- (SQL Editor) PO migracji 030_driver_payroll.sql. Celowo poza katalogiem
-- migrations/, żeby `supabase db push` nie wykonywał go ponownie.
--
-- Klaudiusz zatwierdza (widzi stawki i kwoty, wysyła zestawienie do Ozar),
-- Maciej Ch. wpisuje (dni, urlopy, chorobowe, uznania, potrącenia).
-- Adres Klaudiusza występuje w dwóch pisowniach: w migracji 023 jako
-- "banaszkiewicz", w zleceniu jako "banaszkieicz" — dopasowuję obie, a zapytanie
-- na końcu pokaże, które konto faktycznie istnieje.

insert into payroll_roles (user_id, role, note)
select id, 'approver', 'zatwierdza zestawienie dla Ozar Trans'
from auth.users
where lower(email) in ('klaudiusz@banaszkiewicz-grupa.pl', 'klaudiusz@banaszkieicz-grupa.pl')
on conflict (user_id, role) do nothing;

insert into payroll_roles (user_id, role, note)
select id, 'editor', 'wpisuje dni, urlopy, chorobowe, uznania i potrącenia'
from auth.users
where lower(email) = 'maciej.ch@bminvestgroup.eu'
on conflict (user_id, role) do nothing;

-- Maciej Witkowski: nadzór i zastępstwo obu kont (zatwierdzający + wpisujący).
-- Rola approver daje w bazie także uprawnienia wpisującego; wiersz editor
-- dopisuję jawnie, żeby zastępstwo było widoczne w tabeli ról.
insert into payroll_roles (user_id, role, note)
select id, 'approver', 'nadzór; zastępuje zatwierdzającego'
from auth.users where lower(email) = 'maciej.witkowski@bminvestgroup.eu'
on conflict (user_id, role) do nothing;

insert into payroll_roles (user_id, role, note)
select id, 'editor', 'nadzór; zastępuje wpisującego'
from auth.users where lower(email) = 'maciej.witkowski@bminvestgroup.eu'
on conflict (user_id, role) do nothing;

-- Kontrola: powinny być CZTERY wiersze (Klaudiusz: approver; Maciej Ch.: editor;
-- Maciej Witkowski: approver i editor).
select u.email, r.role
from payroll_roles r join auth.users u on u.id = r.user_id
order by r.role, u.email;
