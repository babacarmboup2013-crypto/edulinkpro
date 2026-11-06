-- Appliqué en production le 06/11/2026 (migration « verrouillage_comptabilite_groupe »).
-- Verrouillage de la Comptabilité d'un groupe scolaire (ex. GS BPEN) : seul le Comptable/Gestionnaire y
-- entre directement ; les autres rôles saisissent le code d'accès du comptable (vérifié côté serveur).
-- Pour verrouiller un autre groupe :  insert into public.groupes_compta_verrouillee (groupe_id, libelle) values ('<uuid>', '<nom>');
-- Pour déverrouiller :                delete from public.groupes_compta_verrouillee where groupe_id = '<uuid>';
create table if not exists public.groupes_compta_verrouillee (
  groupe_id uuid primary key,
  libelle   text,
  created_at timestamptz not null default now()
);
alter table public.groupes_compta_verrouillee enable row level security;
revoke all on public.groupes_compta_verrouillee from anon, authenticated;
insert into public.groupes_compta_verrouillee (groupe_id, libelle)
values ('dac8c2eb-3d02-4def-b008-aacc19ddfdf7', 'GS BPEN') on conflict (groupe_id) do nothing;

create or replace function public.compta_est_verrouillee(p_school_id uuid)
returns boolean language sql security definer set search_path to 'public' stable as $$
  select exists (select 1 from public.schools s join public.groupes_compta_verrouillee g on g.groupe_id = s.groupe_id where s.id = p_school_id);
$$;

create or replace function public.check_compta_code(p_school_id uuid, p_code text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_groupe uuid; v_key text; v_ok boolean;
begin
  if coalesce(trim(p_code), '') = '' then return false; end if;
  select s.groupe_id into v_groupe from public.schools s where s.id = p_school_id;
  if v_groupe is null or not exists (select 1 from public.groupes_compta_verrouillee where groupe_id = v_groupe) then return true; end if;
  v_key := 'compta:' || p_school_id::text;
  if public._rl_is_locked(v_key) then
    raise exception 'Trop de tentatives. Réessayez dans % minute(s).', public._rl_remaining_minutes(v_key);
  end if;
  select exists (
    select 1 from public.schools s join public.school_data sd on sd.school_id = s.id,
           jsonb_array_elements(coalesce(sd.payload -> 'personnel', '[]'::jsonb)) e
    where s.groupe_id = v_groupe and coalesce(e ->> 'role', '') = 'Comptable/Gestionnaire'
      and coalesce(e ->> 'code', '') <> '' and lower(trim(e ->> 'code')) = lower(trim(p_code))
  ) into v_ok;
  if v_ok then perform public._rl_success(v_key); else perform public._rl_fail(v_key); end if;
  return v_ok;
end $$;
revoke all on function public.compta_est_verrouillee(uuid) from public;
revoke all on function public.check_compta_code(uuid, text) from public;
grant execute on function public.compta_est_verrouillee(uuid) to anon, authenticated, service_role;
grant execute on function public.check_compta_code(uuid, text) to anon, authenticated, service_role;
