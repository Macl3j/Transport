-- ============================================================
-- TruckCalc HBM — rzeczywiste daty podjęcia i dostawy zlecenia
-- Rejestr transportów z Rokos ma dwie pary dat: planowane ("Podjęcie",
-- "Dostarczenie") i rzeczywiste ("Podjęcie rzeczywiste", "Dostarczenie
-- rzeczywiste"). Import zapisywał dotąd tylko planowane (pickup_date,
-- delivery_date), a w rejestrze za wrzesień 2026 różnią się one od
-- rzeczywistych w ok. 15% zleceń (75 podjęć, 66 dostaw).
--
-- Moduł "Rozliczenia kierowców" liczy z nich sugerowane dni pracy, więc
-- potrzebuje dat rzeczywistych. Dodaję OSOBNE kolumny zamiast podmieniać
-- pickup_date/delivery_date, żeby nie zmienić wyników innych modułów
-- (kondycja finansowa, analiza), które korzystają z dat planowanych.
-- Po migracji wczytaj ponownie rejestr transportów na /import — import
-- uzupełni nowe kolumny dla zleceń, które już są w bazie (upsert po
-- order_number).
-- ============================================================

alter table route_history
  add column if not exists pickup_actual   date,
  add column if not exists delivery_actual date;
