-- Contact origin is independent of the sales status.
alter table public.crm_contacts
  add column source text not null default 'manual'
  check (source in ('manual', 'website'));

-- Recover earlier website submissions from the integration's receipt records
-- or the exact generated note header used by the original integration.
update public.crm_contacts c set source = 'website'
where exists (
  select 1 from public.crm_website_receipts r where r.contact_id = c.id
) or exists (
  select 1 from public.crm_activities a
  where a.contact_id = c.id and a.activity_type = 'note'
    and split_part(a.description, E'\n', 1) = 'Źródło: formularz strony B&M'
);

create or replace function public.receive_bm_website_enquiry(p_request_id uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_contact uuid;
begin
  insert into crm_website_receipts(request_id) values(p_request_id) on conflict do nothing;
  if not found then return; end if;
  insert into crm_contacts(company_name,contact_person,email,phone,routes,status,source)
  values(p_data->>'company',p_data->>'name',p_data->>'email',nullif(p_data->>'phone',''),
    concat_ws(' → ',nullif(p_data->>'from',''),nullif(p_data->>'to','')),'prospekt','website')
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
