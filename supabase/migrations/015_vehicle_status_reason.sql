-- Rozróżnienie POWODU wyłączenia pojazdu z eksploatacji — dotąd is_active=false
-- mieszało "uziemiony/na sprzedaż" z pojazdami wycofanymi trwale po poważnej
-- awarii lub wypadku. Zarząd potrzebuje osobno widzieć ile pojazdów nie może
-- być użytych do transportu z powodu awarii/wypadku.

alter table vehicles add column if not exists status_reason text;

comment on column vehicles.status_reason is
  'Powód wyłączenia z eksploatacji (gdy is_active=false): uziemiony | wycofany_awaria | wycofany_wypadek. NULL = aktywny lub powód nieokreślony.';
