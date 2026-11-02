-- Migracja 034: Dodanie pola "Uwagi i ustalenia" (notes) dla jednostek floty (ciagniki, naczepy, podwykonawcy).
-- Limit 2000 znakow, opcjonalne.
-- Bez zmian istniejacych danych, uprawnien i statusow pojazdow.

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS notes text CHECK (notes IS NULL OR length(notes) <= 2000);

COMMENT ON COLUMN vehicles.notes IS
  'Uwagi i ustalenia dla jednostki floty (konieczne naprawy, ustalenia z kierowca lub serwisem). Limit 2000 znakow. NULL = brak uwag.';
