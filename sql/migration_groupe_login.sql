-- ============================================================
--  EduLink Pro — CONNEXION « GROUPE SCOLAIRE » PAR CODE ÉCOLE
--  À exécuter dans l'éditeur SQL de Supabase (après
--  migration_school_cycles.sql et migration_rate_limit.sql).
--  Idempotent.
--
--  Nouvelle règle : l'onglet « Groupe scolaire » authentifie avec le
--  code d'accès D'UNE ÉCOLE (groupe scolaire = école 2 à 5 cycles) et
--  ouvre l'application en LECTURE SEULE sur CETTE école — plus de
--  consultation de circonscription depuis l'écran de connexion
--  (réservée au Super Admin).
--
--  Deux RPC SECURITY DEFINER (l'anon ne lit jamais les codes) :
--   1) check_groupe_code : valide le code école + groupe (cycles ≥ 2) ;
--   2) get_groupe_school_data : lecture seule de l'école via son code,
--      en masquant les codes du personnel (comme get_school_data_ief).
--  Le rate limiting est partagé (espace de clés 'groupe:').
-- ============================================================

-- ------------------------------------------------------------
-- 1) VÉRIFICATION DU CODE (écran de connexion)
--    Retourne { ok, nom, school_id } pour une école active à
--    2+ cycles, { ok:false, not_groupe:true } pour une école simple
--    (1 cycle) et { ok:false } si le code est inconnu. Ne renvoie
--    JAMAIS le code stocké.
-- ------------------------------------------------------------
create or replace function public.check_groupe_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key     text := 'groupe:' || md5(coalesce(p_code, ''));
  v_id      uuid;
  v_name    text;
  v_cycles  text[];
  v_min     integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    return jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  end if;

  select id, name, cycles into v_id, v_name, v_cycles
  from public.schools
  where code = p_code and actif is not false
  limit 1;

  if v_id is null then
    perform public._rl_fail(v_key);
    return jsonb_build_object('ok', false);
  end if;

  if coalesce(cardinality(v_cycles), 0) < 2 then
    -- Code valide mais école simple (1 cycle) : ce n'est pas un échec
    -- d'authentification, juste un cas hors périmètre de l'onglet.
    return jsonb_build_object('ok', false, 'not_groupe', true, 'nom', v_name);
  end if;

  perform public._rl_success(v_key);
  return jsonb_build_object('ok', true, 'nom', v_name, 'school_id', v_id);
end;
$$;

grant execute on function public.check_groupe_code(text) to anon;
grant execute on function public.check_groupe_code(text) to authenticated;

-- ------------------------------------------------------------
-- 2) LECTURE SEULE DE L'ÉCOLE (consultation « Groupe scolaire »)
--    Le code de l'école est revérifié à CHAQUE requête ; les codes du
--    personnel sont MASQUÉS dans la réponse ; le rate limiting est
--    partagé avec la connexion (même espace de clés 'groupe:').
-- ------------------------------------------------------------
create or replace function public.get_groupe_school_data(p_school_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key     text := 'groupe:' || md5(coalesce(p_code, ''));
  v_ok      boolean;
  v_payload jsonb;
  v_clean   jsonb;
  v_min     integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    return jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  end if;

  select exists (
    select 1 from public.schools s
    where s.id = p_school_id and s.code = p_code and s.actif is not false
  ) into v_ok;

  if not coalesce(v_ok, false) then
    perform public._rl_fail(v_key);
    return jsonb_build_object('ok', false, 'error', 'Accès refusé');
  end if;
  perform public._rl_success(v_key);

  select payload into v_payload
  from public.school_data
  where school_id = p_school_id
  limit 1;
  if v_payload is null then
    return jsonb_build_object('ok', false, 'error', 'Aucune donnée scolaire disponible');
  end if;

  -- Supervision lecture seule : AUCUN code d'accès du personnel ne transite.
  select coalesce(jsonb_agg(elem - 'code'), '[]'::jsonb)
    into v_clean
  from jsonb_array_elements(coalesce(v_payload -> 'personnel', '[]'::jsonb)) elem;

  return jsonb_build_object('ok', true, 'data', jsonb_set(v_payload, '{personnel}', v_clean));
end;
$$;

grant execute on function public.get_groupe_school_data(uuid, text) to anon;
grant execute on function public.get_groupe_school_data(uuid, text) to authenticated;

-- ============================================================
--  FIN DE LA MIGRATION
--  Appliquez puis rechargez la page (F5).
-- ============================================================