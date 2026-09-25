-- A single transaction creates the prospect and its enquiry history.
-- Retrying the same submission never creates a second contact.
create table public.crm_website_receipts (
  request_id uuid primary key,
  contact_id uuid references public.crm_contacts(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.crm_website_receipts enable row level security;
revoke all on public.crm_website_receipts from public, anon, authenticated;

create or replace function public.receive_bm_website_enquiry(p_request_id uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_contact uuid;
begin
  insert into crm_website_receipts(request_id) values(p_request_id) on conflict do nothing;
  if not found then return; end if;
  insert into crm_contacts(company_name,contact_person,email,phone,routes,status)
  values(p_data->>'company',p_data->>'name',p_data->>'email',nullif(p_data->>'phone',''),
    concat_ws(' → ',nullif(p_data->>'from',''),nullif(p_data->>'to','')),'prospekt')
  returning id into v_contact;
  insert into crm_activities(contact_id,activity_type,description)
  values(v_contact,'note',concat_ws(E'\n',
    'Źródło: formularz strony B&M',
    'Usługa: '||(p_data->>'service'),
    'Załadunek: '||(p_data->>'from'),'Rozładunek: '||(p_data->>'to'),
    'Termin: '||coalesce(nullif(p_data->>'date',''),'Do ustalenia'),
    'Masa (kg): '||coalesce(nullif(p_data->>'weight',''),'Nie podano'),
    'Palety: '||coalesce(nullif(p_data->>'pallets',''),'Nie podano'),
    'Uwagi: '||coalesce(nullif(p_data->>'cargo',''),'Brak'),
    'Id zapytania: '||p_request_id::text));
  update crm_website_receipts set contact_id=v_contact where request_id=p_request_id;
end;
$$;
revoke all on function public.receive_bm_website_enquiry(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.receive_bm_website_enquiry(uuid,jsonb) to service_role;
