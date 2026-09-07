-- Pole adresowe dla kontaktow CRM, wypelniane recznie albo automatycznie na
-- podstawie NIP/VAT (biala lista MF dla polskich NIP, VIES dla zagranicznych
-- VAT UE). "city" trzymany osobno jako pole pomocnicze pod przyszla mape
-- klientow (geokodowanie po miescie, nie po pelnym adresie).

alter table crm_contacts add column if not exists address text;
alter table crm_contacts add column if not exists city text;
alter table crm_contacts add column if not exists address_source text; -- 'nip_lookup' | 'manual' | null
