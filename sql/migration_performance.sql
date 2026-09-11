-- ================================================================
-- MIGRATION : PERFOMANCES CONNEXION & CHARGEMENT
--
-- Objectifs :
--   1) Accélérer la recherche d'école (écran de connexion). La RPC
--      `search_public_schools` fait un `name ILIKE '%…%'` : sans index
--      trigramme, PostgreSQL scanne toute la table `schools` à chaque
--      frappe → lent dès que l'annuaire grossit. Un index GIN trigramme
--      sur `lower(name)` rend cette recherche instantanée.
--   2) Alléger le sondage "nouvelles demandes de transfert" du tableau
--      de bord école : l'application téléchargeait le payload complet
--      (élèves, paiements, pointages…) toutes les 30 secondes. Nouvelle
--      RPC `list_pending_transfers` : elle vérifie le code école (même
--      logique que get_school_data, rate-limiting compris) et ne renvoie
--      QUE les demandes en attente — quelques kilo-octets au lieu du
--      payload entier.
--
-- Idempotente : `create index if not exists`, `create extension if not
-- exists`, `create or replace function`. Exécutable plusieurs fois sans
-- effet de bord.
-- ================================================================

-- ------------------------------------------------------------
-- 1) EXTENSION TRIGRAMME + INDEX DE RECHERCHE D'ÉCOLE
-- ------------------------------------------------------------
create extension if not exists pg_trgm;

create index if not exists idx_schools_name_trgm
  on public.schools using gin (lower(name) gin_trgm_ops);

-- Les recherches filtrent déjà sur `actif` : index banal qui évite de
-- balayer les écoles désactivées au passage (la plupart du temps le
-- filtre `actif is not false` est déjà chevauché par l'index trigramme,
-- ce second index ne coûte rien et aide les requêtes simples).
create index if not exists idx_schools_actif
  on public.schools (actif);

-- ------------------------------------------------------------
-- 2) RPC LÉGÈRE : LISTE DES DEMANDES DE TRANSFERT EN ATTENTE
--    (même vérification du code école + rate-limiting que
--    get_school_data, sans transporter le payload complet)
-- ------------------------------------------------------------
create or replace function public.list_pending_transfers(p_school_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_key     text := 'school:' || coalesce(p_school_id::text, '');
  v_ok      boolean;
  v_payload jsonb;
  v_pending jsonb := '[]'::jsonb;
begin
  if public._rl_is_locked(v_key) then
    raise exception 'Trop de tentatives. Réessayez dans % minute(s).',
      public._rl_remaining_minutes(v_key);
  end if;

  select exists (
    select 1 from public.schools
    where id = p_school_id
      and actif is not false
      and code = p_code
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

  -- Seules les demandes en attente, avec le minimum d'infos nécessaires
  -- à la notification (nom, classes d'origine/destination).
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_pending
  from (
    select jsonb_build_object(
      'id',             e ->> 'id',
      'studentName',    e ->> 'studentName',
      'fromClassName',  e ->> 'fromClassName',
      'toClassName',    e ->> 'toClassName',
      'status',         e ->> 'status'
    ) as x
    from jsonb_array_elements(coalesce(v_payload -> 'studentTransferRequests', '[]'::jsonb)) e
    where e ->> 'status' = 'pending'
  ) t;

  return jsonb_build_object('ok', true, 'pending', coalesce(v_pending, '[]'::jsonb));
end;
$$;

grant execute on function public.list_pending_transfers(uuid, text) to anon;
grant execute on function public.list_pending_transfers(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3) RÉFRAÎCHIR LES STATISTIQUES DU PLANNIFICATEUR
-- ------------------------------------------------------------
analyze public.schools;
analyze public.school_data;

-- ------------------------------------------------------------
-- NB : le temps de connexion principal restant est le TRANSFERT du
-- payload scolaire complet (get_school_data lit une seule ligne JSONB —
-- prompte côté serveur). Pour une école à très gros volume, c'est le
-- réseau qui domine. Options si besoin :
--   - monter le pool/les ressources du projet Supabase ;
--   - ou scinder les gros blocs (pointage, audit) hors du payload
--     central (à préparer dans une migration ultérieure).
-- ------------------------------------------------------------