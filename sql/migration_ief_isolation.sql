-- ============================================================
--  SYGENOP / EduLink Pro — ISOLEMENT STRICT DES DONNÉES PAR IEF
--  À exécuter UNE FOIS dans l'éditeur SQL de Supabase (après
--  migration_rate_limit.sql et migration_ief_grand_dakar.sql).
--
--  Règle : une IEF connectée avec SON code ne peut lire que les
--  données des écoles de SA circonscription. La vérification est
--  faite CÔTÉ SERVEUR (le client n'est qu'une interface).
--
--  Cette RPC remplace la lecture anonyme historique (Edge Function
--  sans vérification de périmètre) pour le tableau de bord IEF :
--   • le code de lecture est revérifié à CHAQUE requête ;
--   • l'école demandée doit appartenir à l'IEF du code ;
--   • les codes du personnel sont MASQUÉS dans la réponse ;
--   • le rate limiting est PARTAGÉ avec la connexion IEF
--     (même espace de clés 'ief:' → 5 échecs = blocage 15 min).
-- ============================================================

drop function if exists public.get_school_data_ief(uuid, text);

create or replace function public.get_school_data_ief(p_school_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key     text := 'ief:' || md5(coalesce(p_code, ''));
  v_ief_id  uuid;
  v_allowed boolean := false;
  v_payload jsonb;
  v_clean   jsonb;
  v_min     integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    return jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  end if;

  -- 1) Résout l'IEF à partir du code fourni :
  --    a) code de lecture d'une IEF décentralisée (iefs.code_lecture)
  select i.id into v_ief_id
  from public.iefs i
  where i.code_lecture = p_code and i.actif is true
  limit 1;

  --    b) sinon compte de la table admins (rattaché à une IEF)
  if v_ief_id is null then
    select a.ief_id into v_ief_id
    from public.admins a
    where a.code = p_code and a.actif is true
    limit 1;
  end if;

  -- 2) L'école demandée doit appartenir à CETTE IEF — c'est ici que
  --    l'isolement entre circonscriptions est garanti côté serveur.
  if v_ief_id is not null then
    select exists (
      select 1 from public.schools s
      where s.id = p_school_id and s.ief_id = v_ief_id
    ) into v_allowed;
  end if;

  if not v_allowed then
    perform public._rl_fail(v_key);
    return jsonb_build_object('ok', false, 'error', 'Accès IEF refusé : école hors circonscription');
  end if;
  perform public._rl_success(v_key);

  -- 3) Charge le payload de l'école autorisée.
  select payload into v_payload
  from public.school_data
  where school_id = p_school_id
  limit 1;
  if v_payload is null then
    return jsonb_build_object('ok', false, 'error', 'Aucune donnée scolaire disponible');
  end if;

  -- 4) Supervision lecture seule : AUCUN code d'accès ne doit transiter.
  --    (Le code de connexion d'une école vit dans schools.code, jamais
  --    dans le payload ; seuls les codes du personnel y figurent.)
  select coalesce(jsonb_agg(elem - 'code'), '[]'::jsonb)
    into v_clean
  from jsonb_array_elements(coalesce(v_payload -> 'personnel', '[]'::jsonb)) elem;

  return jsonb_build_object('ok', true, 'data', jsonb_set(v_payload, '{personnel}', v_clean));
end;
$$;

grant execute on function public.get_school_data_ief(uuid, text) to anon;
grant execute on function public.get_school_data_ief(uuid, text) to authenticated;

-- ============================================================
--  FIN DE LA MIGRATION
-- ============================================================
