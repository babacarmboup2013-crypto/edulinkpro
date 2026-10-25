-- ============================================================
--  EduLink Pro — LECTURE SEULE D'UNE ÉCOLE PAR UN « GROUPE SCOLAIRE »
--  À exécuter dans l'éditeur SQL de Supabase (après
--  migration_groupes_scolaires.sql et migration_rate_limit.sql).
--  Idempotent : peut être relancé sans risque.
--
--  Utilisée par l'onglet de connexion « Groupe scolaire » :
--  get_school_data_groupe(p_school_id, p_code) renvoie le payload d'une
--  école UNIQUEMENT si p_code est le code d'un groupe scolaire actif ET
--  que l'école appartient à ce groupe (schools.groupe_id).
--  Les codes d'accès du personnel sont masqués. Rate limiting partagé
--  avec check_groupe_code (clé 'groupe:').
--
--  Tant que cette migration n'est pas appliquée, l'application retombe
--  automatiquement sur get_school_data_ief (comportement précédent).
-- ============================================================

create or replace function public.get_school_data_groupe(p_school_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key       text := 'groupe:' || md5(coalesce(p_code, ''));
  v_groupe_id uuid;
  v_allowed   boolean := false;
  v_payload   jsonb;
  v_clean     jsonb;
  v_min       integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    return jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  end if;

  select g.id into v_groupe_id
  from public.groupes_scolaires g
  where g.code = p_code and g.actif is not false
  limit 1;

  if v_groupe_id is not null then
    select exists (
      select 1 from public.schools s
      where s.id = p_school_id and s.groupe_id = v_groupe_id
    ) into v_allowed;
  end if;

  if not v_allowed then
    perform public._rl_fail(v_key);
    return jsonb_build_object('ok', false, 'error', 'Accès refusé : école hors du groupe scolaire');
  end if;
  perform public._rl_success(v_key);

  select payload into v_payload
  from public.school_data
  where school_id = p_school_id
  limit 1;
  if v_payload is null then
    return jsonb_build_object('ok', false, 'error', 'Aucune donnée scolaire disponible');
  end if;

  -- Lecture seule : AUCUN code d'accès du personnel ne transite.
  select coalesce(jsonb_agg(elem - 'code'), '[]'::jsonb)
    into v_clean
  from jsonb_array_elements(coalesce(v_payload -> 'personnel', '[]'::jsonb)) elem;

  return jsonb_build_object('ok', true, 'data', jsonb_set(v_payload, '{personnel}', v_clean));
end;
$$;

grant execute on function public.get_school_data_groupe(uuid, text) to anon;
grant execute on function public.get_school_data_groupe(uuid, text) to authenticated;
