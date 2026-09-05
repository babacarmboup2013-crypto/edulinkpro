-- ================================================================
-- MIGRATION : suppression de l'énumération publique des écoles et
-- du personnel depuis l'écran de connexion (faille de fuite de
-- données personnelles signalée par un testeur).
--
-- AVANT : la vue `public_schools` (SELECT accordé à `anon`) et la
-- fonction `get_school_personnel` (EXECUTE accordé à `anon`)
-- permettaient à n'importe quel visiteur, SANS AUCUN code d'accès,
-- de lister la totalité des écoles du système puis le personnel
-- nominatif (prénom, nom, rôle) de n'importe laquelle d'entre elles.
--
-- APRÈS : ces deux points d'accès anonymes sont retirés. Ils sont
-- remplacés par des RPC de RECHERCHE, qui :
--   - exigent une requête d'au moins 2 caractères (aucun "listing"
--     à vide possible) ;
--   - plafonnent le nombre de résultats renvoyés (8 maximum) ;
--   - restent, comme avant, des lectures anonymes (nécessaires pour
--     qu'un utilisateur puisse identifier son école/son profil AVANT
--     de saisir son code d'accès) mais ne permettent plus d'exporter
--     l'annuaire complet en une seule requête.
--
-- Limite assumée : ceci ne remplace pas une authentification par
-- compte individuel (email + mot de passe + OTP), qui reste la
-- correction de fond à envisager séparément. Il s'agit ici de
-- fermer l'exposition immédiate et massive de données personnelles.
-- ================================================================

-- ------------------------------------------------------------
-- 1) RETRAIT DE L'ACCÈS ANONYME EN LISTING COMPLET
-- ------------------------------------------------------------
revoke select on public.public_schools from anon;
revoke execute on function public.get_school_personnel(uuid) from anon;
-- Le personnel authentifié (Directeur/Admin déjà connecté ailleurs
-- dans l'appli) n'a pas besoin de cette fonction anonyme : l'accès
-- authentifié aux données du personnel passe par get_school_data /
-- get_school_data_admin / get_school_data_ief, jamais par ici.
revoke execute on function public.get_school_personnel(uuid) from authenticated;

-- ------------------------------------------------------------
-- 2) RECHERCHE D'ÉCOLE PAR NOM (au lieu du listing complet)
-- ------------------------------------------------------------
create or replace function public.search_public_schools(p_query text)
returns table (id uuid, name text, type text, cycle text, actif boolean, ief_id uuid)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if p_query is null or length(trim(p_query)) < 2 then
    return; -- aucune requête trop courte : pas de listing "à vide"
  end if;

  return query
    select s.id, s.name, s.type, s.cycle, s.actif, s.ief_id
    from public.schools s
    where s.actif is not false
      and s.name ilike '%' || trim(p_query) || '%'
    order by s.name asc
    limit 8;
end;
$$;

grant execute on function public.search_public_schools(text) to anon;
grant execute on function public.search_public_schools(text) to authenticated;

-- ------------------------------------------------------------
-- 3) RECHERCHE DE PERSONNEL PAR NOM, DANS UNE ÉCOLE DONNÉE
--    (au lieu du listing complet du personnel de l'école)
-- ------------------------------------------------------------
create or replace function public.search_school_personnel(p_school_id uuid, p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_payload jsonb;
  v_personnel jsonb := '[]'::jsonb;
  v_p jsonb;
  v_out jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_q text := lower(trim(coalesce(p_query, '')));
begin
  if length(v_q) < 2 then
    return jsonb_build_object('ok', true, 'personnel', '[]'::jsonb);
  end if;

  select payload into v_payload from public.school_data where school_id = p_school_id limit 1;
  v_personnel := coalesce(v_payload->'personnel', '[]'::jsonb);

  for v_p in select * from jsonb_array_elements(v_personnel)
  loop
    exit when v_count >= 8;
    if lower(coalesce(v_p->>'prenom', '') || ' ' || coalesce(v_p->>'nom', '')) like '%' || v_q || '%'
       or lower(coalesce(v_p->>'nom', '')) like '%' || v_q || '%' then
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'id', v_p->>'id', 'prenom', v_p->>'prenom', 'nom', v_p->>'nom', 'role', v_p->>'role'
      ));
      v_count := v_count + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'personnel', v_out);
end;
$$;

grant execute on function public.search_school_personnel(uuid, text) to anon;
grant execute on function public.search_school_personnel(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- NB : cette migration ne touche pas aux tables/fonctions utilisées
-- par les tableaux de bord Admin/IEF déjà authentifiés (`schools`
-- via read-schools/admin-write, get_school_data_admin,
-- get_school_data_ief) — ces chemins restent inchangés.
-- ------------------------------------------------------------
