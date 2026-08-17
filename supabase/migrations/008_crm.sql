-- ============================================================
-- TruckCalc HBM — CRM handlowca (pozyskiwanie nowych kontaktów)
-- ============================================================

create extension if not exists "uuid-ossp";

-- ─── KONTAKTY ─────────────────────────────────────────────────
create table if not exists crm_contacts (
  id               uuid primary key default uuid_generate_v4(),
  company_name     text not null,
  nip              text,
  contact_person   text,
  phone            text,
  email            text,
  routes           text,               -- "Trasy" — np. "ES / GB"
  status           text default 'prospekt',  -- 'prospekt' | 'w_negocjacji' | 'aktywny' | 'stracony'
  assigned_to      text,               -- handlowiec
  next_action_date date,               -- denormalizowane z ostatniej aktywności — szybkie sortowanie listy
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- ─── HISTORIA DZIAŁAŃ (odbyte + zaplanowane) ───────────────────
create table if not exists crm_activities (
  id               uuid primary key default uuid_generate_v4(),
  contact_id       uuid not null references crm_contacts(id) on delete cascade,
  activity_type    text default 'note',   -- 'call' | 'email' | 'meeting' | 'note'
  activity_date    date not null default current_date,
  description      text,
  next_action_date date,                  -- jeśli ustawione → aktualizuje crm_contacts.next_action_date
  created_at       timestamptz default now()
);

-- ─── LOGINY DO SYSTEMÓW PRZETARGOWYCH ──────────────────────────
-- Hasło NIGDY nie jest zapisywane jawnym tekstem — password_encrypted
-- to "iv.tag.ciphertext" (AES-256-GCM), szyfrowane/odszyfrowywane
-- wyłącznie server-side w src/app/api/crm/portal/* (crmCrypto.ts).
-- Klucz szyfrujący (CRM_ENCRYPTION_KEY) istnieje tylko w zmiennych
-- środowiskowych Vercela — nigdy w kodzie klienta.
create table if not exists crm_tender_portals (
  id                 uuid primary key default uuid_generate_v4(),
  contact_id         uuid not null references crm_contacts(id) on delete cascade,
  portal_name        text,
  portal_url         text,
  username            text,
  password_encrypted text,   -- "iv.tag.ciphertext", base64 segments
  notes              text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create index if not exists idx_crm_contacts_next_action on crm_contacts(next_action_date);
create index if not exists idx_crm_contacts_status       on crm_contacts(status);
create index if not exists idx_crm_activities_contact    on crm_activities(contact_id, activity_date desc);
create index if not exists idx_crm_portals_contact        on crm_tender_portals(contact_id);
