-- ============================================================
--  EduLink Pro — TRANSPARENCE GS BPEN (suite)
--  À exécuter UNE FOIS dans Supabase → SQL Editor → Run.
--  Idempotent.
--
--  1) RPC list_audit_miroir_bpen : lecture du miroir d'audit,
--     réservée au SUPER ADMIN RACINE (code maître), pas aux IEF.
--  2) Active la double validation financière sur les écoles
--     « GS BPEN% » (config.double_validation_financiere = true).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Lecture protégée du miroir
-- ------------------------------------------------------------
create or replace function public.list_audit_miroir_bpen(
  p_admin_code text,
  p_school_id  uuid default null,
  p_limit      integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check jsonb;
  v_res   jsonb;
begin
  v_check := public.check_admin_code(p_admin_code);

  -- Super Admin racine uniquement : un IEF décentralisé ne peut pas consulter.
  if coalesce(v_check->>'ok', '') <> 'true'
     or coalesce(v_check->>'nom', '') <> 'Super Admin' then
    return jsonb_build_object('ok', false);
  end if;

  select jsonb_agg(x order by x->>'created_at' desc)
  into v_res
  from (
    select jsonb_build_object(
      'id', m.id,
      'school_id', m.school_id,
      'school', s.name,
      'occurred_at', m.occurred_at_text,
      'created_at', m.created_at,
      'actor', m.actor,
      'actor_role', m.actor_role,
      'action', m.action,
      'details', m.details
    ) as x
    from public.audit_logs_miroir m
    join public.schools s on s.id = m.school_id
    where lower(coalesce(s.name, '')) like 'gs bpen%'
      and (p_school_id is null or m.school_id = p_school_id)
    order by m.created_at desc
    limit least(greatest(coalesce(p_limit, 1000), 1), 5000)
  ) t;

  return jsonb_build_object('ok', true, 'entries', coalesce(v_res, '[]'::jsonb));
end $$;

revoke all on function public.list_audit_miroir_bpen(text, uuid, integer) from public;
grant execute on function public.list_audit_miroir_bpen(text, uuid, integer) to anon;
grant execute on function public.list_audit_miroir_bpen(text, uuid, integer) to authenticated;

-- ------------------------------------------------------------
-- 2) Double validation financière sur GS BPEN
-- ------------------------------------------------------------
update public.school_data sd
set payload = jsonb_set(
  coalesce(sd.payload, '{}'::jsonb),
  '{config,double_validation_financiere}',
  'true'::jsonb,
  true
)
from public.schools s
where sd.school_id = s.id
  and lower(coalesce(s.name, '')) like 'gs bpen%'
  and coalesce(sd.payload->'config'->>'double_validation_financiere', '') <> 'true';

commit;

-- Vérification
select s.name as ecole,
       sd.payload->'config'->>'transparence_renforcee' as transparence,
       sd.payload->'config'->>'double_validation_financiere' as double_validation
from public.schools s
join public.school_data sd on sd.school_id = s.id
where lower(coalesce(s.name, '')) like 'gs bpen%'
order by s.name;
