-- ============================================================
-- Zamawianie części — cofnięcie zatwierdzenia (/serwis/zamowienia)
-- Zatwierdzający może cofnąć WŁASNĄ decyzję "zatwierdzona": zamówienie
-- wraca do statusu "oczekuje" i znów czeka na akceptację. Cudzych decyzji
-- cofnąć nie można. Funkcja security definer, bo polityki RLS z migracji 024
-- pozwalają zatwierdzającemu zmieniać tylko wiersze o statusie "oczekuje".
-- ============================================================

create or replace function revoke_part_order_approval(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from part_order_roles pr where pr.user_id = auth.uid() and pr.role = 'approver'
  ) then
    raise exception 'Brak uprawnień zatwierdzającego';
  end if;

  update part_orders
     set status = 'oczekuje',
         decided_by = null,
         decided_at = null,
         decision_note = null,
         updated_at = now()
   where id = p_order_id
     and status = 'zatwierdzona'
     and decided_by = auth.uid();

  if not found then
    raise exception 'Można cofnąć tylko własne zatwierdzenie';
  end if;
end;
$$;

revoke all on function revoke_part_order_approval(uuid) from public, anon;
grant execute on function revoke_part_order_approval(uuid) to authenticated;
