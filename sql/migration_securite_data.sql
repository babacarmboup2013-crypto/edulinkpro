-- ============================================================
--  SYGENOP / EduLink Pro — SÉCURISATION DES DONNÉES (school_data)
--  À exécuter UNE FOIS dans l'éditeur SQL de Supabase.
--  Idempotent : peut être relancé sans risque (DROP ... IF EXISTS).
--
--  Problème corrigé :
--  La table `school_data` contient TOUTES les données scolaires
--  (élèves, notes, paiements, personnel, barèmes, journal d'audit).
--  Avec la clé "anon" publique (embarquée dans le code client),
--  n'importe qui pouvait lire/écrire ces lignes en masse via l'API
--  REST (`school_data?select=school_id,payload`), exposant ainsi
--  toute la base.
--
--  Cette migration :
--   1) Révoque l'accès REST direct à `school_data` pour anon.
--   2) Crée des fonctions RPC SECURITY DEFINER qui ne renvoient
--      QUE des AGRÉGATS (compteurs, totaux) — jamais les payloads
--      bruts — pour les vues IEF / Super Admin / classement.
--   3) Fournit get_school_data / save_school_data pour la lecture
--      et l'écriture d'UNE école, vérifiées par le code d'accès.
--   4) Verrouille les tables sensibles (schools, iefs, admins,
--      ief_config) : suppression des politiques "anon ... using (true)".
-- ============================================================

-- ------------------------------------------------------------
-- 1) RLS stricte sur `school_data` : anon ne peut plus lire/écrire
--    directement. Seules les fonctions SECURITY DEFINER accèderont
--    aux lignes (elles tournent avec le rôle du propriétaire).
-- ------------------------------------------------------------
alter table public.school_data enable row level security;
-- Supprime toute politique existante sur school_data
drop policy if exists "school_data_anon_all" on public.school_data;
drop policy if exists "school_data_anon_read" on public.school_data;
drop policy if exists "school_data_anon_insert" on public.school_data;
drop policy if exists "school_data_anon_update" on public.school_data;
-- Aucune politique pour anon → l'accès REST direct est bloqué par RLS.
-- (Aucune politique créée = aucun accès anon.)

-- ------------------------------------------------------------
-- 2) VUE d'agrégats par école (sans les payloads bruts)
--    Retourne uniquement des nombres agrégés pour les vues
--    IEF / Super Admin / classement inter-écoles.
--    SECURITY DEFINER : l'appelant (anon) n'accède jamais aux
--    payloads, seulement aux statistiques calculées côté serveur.
-- ------------------------------------------------------------
create or replace function public.get_schools_overview(p_ief_id uuid default null, p_include_inactive boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_school record;
  v_payload jsonb;
  v_class jsonb;
  v_student jsonb;
  v_effectif int;
  v_garcons int;
  v_filles int;
  v_classes_actives int;
  v_total_classes int;
  v_p_amount numeric;
  v_total_due numeric;
  v_total_paid numeric;
  v_pay jsonb;
  v_personnel jsonb;
  v_pers_total int;
  v_pers_male int;
  v_pers_female int;
  v_pers_unknown int;
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_has_overview boolean := false;
begin
  -- Le Super Admin racine (p_ief_id null, include_inactive possible) et les
  -- IEF (p_ief_id fourni) peuvent consulter les données de leur périmètre.
  -- NB : cette fonction ne renvoie JAMAIS les payloads ni les codes.
  for v_school in
    select s.id, s.name, s.type, s.cycle, s.actif, s.ief_id
    from public.schools s
    where (p_ief_id is null or s.ief_id = p_ief_id)
      and (p_include_inactive or s.actif is not false)
    order by s.name asc
  loop
    -- Initialisations par école
    v_effectif := 0; v_garcons := 0; v_filles := 0;
    v_classes_actives := 0; v_total_classes := 0;
    v_total_due := 0; v_total_paid := 0;
    v_pers_total := 0; v_pers_male := 0; v_pers_female := 0; v_pers_unknown := 0;

    -- Lecture du payload de l'école (autorisé ici car SECURITY DEFINER)
    select payload into v_payload
    from public.school_data
    where school_id = v_school.id
    limit 1;

    if v_payload is not null then
      -- Classes & élèves
      for v_class in select * from jsonb_each(coalesce(v_payload->'classes', '{}'::jsonb))
      loop
        v_total_classes := v_total_classes + 1;
        v_effectif := v_effectif + (select count(*)::int from jsonb_array_elements(coalesce((v_class.value)->'students', '[]'::jsonb)));
        if (select count(*)::int from jsonb_array_elements(coalesce((v_class.value)->'students', '[]'::jsonb))) > 0 then
          v_classes_actives := v_classes_actives + 1;
        end if;
        for v_student in select * from jsonb_array_elements(coalesce((v_class.value)->'students', '[]'::jsonb))
        loop
          if upper(coalesce(v_student->>'genre','')) = 'M' then v_garcons := v_garcons + 1;
          elsif upper(coalesce(v_student->>'genre','')) = 'F' then v_filles := v_filles + 1;
          end if;
        end loop;
      end loop;

      -- Paiements (due/paid) — approximation : somme des rubriques non utilisable
      -- sans le barème ; on agrège les montants payés déclarés.
      for v_student in
        select value from jsonb_each(v_payload->'classes')
      loop
        for v_pay in select * from jsonb_array_elements(coalesce(v_student.value->'students','[]'::jsonb))
        loop
          for v_p_amount in
            select coalesce((p.value->>'montant')::numeric, 0)
            from jsonb_array_elements(coalesce(v_pay.value->'paiements','[]'::jsonb)) p
          loop
            v_total_paid := v_total_paid + v_p_amount;
          end loop;
        end loop;
      end loop;

      -- Personnel
      v_pers_total := (select count(*)::int from jsonb_array_elements(coalesce(v_payload->'personnel','[]'::jsonb)));
      for v_personnel in select * from jsonb_array_elements(coalesce(v_payload->'personnel','[]'::jsonb))
      loop
        if lower(coalesce(v_personnel->>'genre','')) in ('femme','f','feminin','feminine','female') then v_pers_female := v_pers_female + 1;
        elsif lower(coalesce(v_personnel->>'genre','')) in ('homme','h','m','masculin','masculine','male') then v_pers_male := v_pers_male + 1;
        else v_pers_unknown := v_pers_unknown + 1;
        end if;
      end loop;
    end if;

    v_item := jsonb_build_object(
      'id', v_school.id,
      'name', v_school.name,
      'type', v_school.type,
      'cycle', v_school.cycle,
      'actif', v_school.actif,
      'ief_id', v_school.ief_id,
      'effectif', v_effectif,
      'garcons', v_garcons,
      'filles', v_filles,
      'classesActives', v_classes_actives,
      'totalClasses', v_total_classes,
      'totalPaid', v_total_paid,
      'personnelTotal', v_pers_total,
      'personnelMale', v_pers_male,
      'personnelFemale', v_pers_female,
      'personnelUnknown', v_pers_unknown
    );
    v_items := v_items || jsonb_build_array(v_item);
    v_has_overview := true;
  end loop;

  return jsonb_build_object('ok', true, 'schools', v_items);
end;
$$;

grant execute on function public.get_schools_overview(uuid, boolean) to anon;
grant execute on function public.get_schools_overview(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 3) LECTURE D'UNE ÉCOLE (payload complet) — vérifiée par code
--    Retourne le payload d'UNE école SI le code d'accès est correct.
--    Ne renvoie jamais le code lui-même.
-- ------------------------------------------------------------
create or replace function public.get_school_data(p_school_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_ok boolean;
begin
  -- Vérifie le code d'accès de l'école (active)
  select exists (
    select 1 from public.schools
    where id = p_school_id
      and actif is not false
      and code = p_code
  ) into v_ok;

  if not coalesce(v_ok, false) then
    return jsonb_build_object('ok', false, 'error', 'Accès refusé');
  end if;

  select payload into v_payload
  from public.school_data
  where school_id = p_school_id
  limit 1;

  if v_payload is null then
    return jsonb_build_object('ok', false, 'error', 'Aucune donnée');
  end if;

  return jsonb_build_object('ok', true, 'data', v_payload);
end;
$$;

grant execute on function public.get_school_data(uuid, text) to anon;
grant execute on function public.get_school_data(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 4) ÉCRITURE D'UNE ÉCOLE (payload complet) — vérifiée par code
--    Met à jour ou insère le payload d'UNE école si le code est correct.
-- ------------------------------------------------------------
create or replace function public.save_school_data(p_school_id uuid, p_code text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
  v_exists boolean;
  v_new_version int;
begin
  select exists (
    select 1 from public.schools
    where id = p_school_id
      and actif is not false
      and code = p_code
  ) into v_ok;

  if not coalesce(v_ok, false) then
    return jsonb_build_object('ok', false, 'error', 'Accès refusé');
  end if;

  select exists (
    select 1 from public.school_data where school_id = p_school_id
  ) into v_exists;

  if v_exists then
    update public.school_data
    set payload = p_payload,
        version = version + 1,
        updated_at = now()
    where school_id = p_school_id
    returning version into v_new_version;
  else
    insert into public.school_data (school_id, payload, version, updated_at)
    values (p_school_id, p_payload, 1, now())
    returning version into v_new_version;
  end if;

  return jsonb_build_object('ok', true, 'version', v_new_version);
end;
$$;

grant execute on function public.save_school_data(uuid, text, jsonb) to anon;
grant execute on function public.save_school_data(uuid, text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 4bis) LISTE DU PERSONNEL D'UNE ÉCOLE (pour l'écran de connexion)
--    Retourne UNIQUEMENT noms + rôles (aucun code, aucune note, aucun
--    paiement). L'enseignant a besoin de se voir dans la liste avant de
--    saisir son code personnel. Aucune donnée sensible n'est exposée.
-- ------------------------------------------------------------
create or replace function public.get_school_personnel(p_school_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_personnel jsonb := '[]'::jsonb;
  v_p jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  select payload into v_payload
  from public.school_data
  where school_id = p_school_id
  limit 1;

  v_personnel := coalesce(v_payload->'personnel', '[]'::jsonb);
  for v_p in select * from jsonb_array_elements(v_personnel)
  loop
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_p->>'id',
      'prenom', v_p->>'prenom',
      'nom', v_p->>'nom',
      'role', v_p->>'role'
    ));
  end loop;
  return jsonb_build_object('ok', true, 'personnel', v_out);
end;
$$;

grant execute on function public.get_school_personnel(uuid) to anon;
grant execute on function public.get_school_personnel(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5) AJOUT D'UNE ÉCOLE NEUVE (payload initial vide) — par le Super Admin
--    Le Super Admin crée l'école via `schools` (RPC), puis doit pouvoir
--    initialiser school_data. Cette fonction est réservée au code
--    d'administration (admin_code) pour éviter toute création non autorisée.
-- ------------------------------------------------------------
create or replace function public.init_school_data(p_school_id uuid, p_admin_code text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
  v_cfg text;
  v_exists boolean;
begin
  select value into v_cfg from public.ief_config where key = 'admin_code';
  if coalesce(v_cfg, '') = '' or p_admin_code is distinct from v_cfg then
    return jsonb_build_object('ok', false, 'error', 'Accès refusé');
  end if;

  select exists (select 1 from public.school_data where school_id = p_school_id) into v_exists;
  if not v_exists then
    insert into public.school_data (school_id, payload, version, updated_at)
    values (p_school_id, coalesce(p_payload, '{}'::jsonb), 1, now());
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.init_school_data(uuid, text, jsonb) to anon;
grant execute on function public.init_school_data(uuid, text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 6) VERROUILLAGE DES TABLES SENSIBLES
--    Supprime les politiques "anon ... using (true) with check (true)"
--    qui permettaient à quiconque de lire/écrire les codes et la config.
--    L'accès aux écoles utiles passe par la vue `public_schools`
--    (déjà créée par la migration précédente) et par les RPC ci-dessus.
-- ------------------------------------------------------------
drop policy if exists "schools_anon_all" on public.schools;
drop policy if exists "admins_anon_all" on public.admins;
drop policy if exists "iefs_anon_all" on public.iefs;
drop policy if exists "ief_config_anon_all" on public.ief_config;

-- RLS forcée sur ces tables
alter table public.admins force row level security;
alter table public.iefs force row level security;
alter table public.ief_config force row level security;
alter table public.schools force row level security;

-- La vue publique des écoles (sans codes) reste accessible pour l'écran de login
create or replace view public.public_schools as
  select id, name, type, cycle, actif, ief_id
  from public.schools
  where actif is not false;
grant select on public.public_schools to anon;

-- On s'assure que la colonne updated_at existe (peut manquer sur d'anciennes bases)
alter table public.school_data add column if not exists updated_at timestamptz default now();

-- ============================================================
--  FIN DE LA MIGRATION
--  Rechargez ensuite la page (F5).
-- ============================================================


-- ------------------------------------------------------------
-- 6) LECTURE/ÉCRITURE ADMIN D'UNE ÉCOLE
--    Le client ne lit plus directement school_data après activation
--    de la sécurité. Ces RPC autorisent le code Super Admin racine
--    ou le code admin d'une IEF, sans exposer les données sensibles.
-- ------------------------------------------------------------
create or replace function public.get_school_data_admin(p_school_id uuid, p_admin_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_root boolean := false;
  v_ief_id uuid;
  v_allowed boolean := false;
  v_payload jsonb;
begin
  select exists (
    select 1 from public.ief_config
    where key = 'admin_code' and value = p_admin_code
  ) into v_root;

  if v_root then
    v_allowed := true;
  else
    select i.id into v_ief_id
    from public.iefs i
    where i.code_admin = p_admin_code and i.actif is true
    limit 1;

    if v_ief_id is null then
      select a.ief_id into v_ief_id
      from public.admins a
      where a.code = p_admin_code and a.actif is true and a.role = 'admin'
      limit 1;
    end if;

    v_allowed := v_ief_id is not null and exists (
      select 1 from public.schools s
      where s.id = p_school_id and s.ief_id = v_ief_id
    );
  end if;

  if not v_allowed then
    return jsonb_build_object('ok', false, 'error', 'Accès administrateur refusé');
  end if;

  select payload into v_payload
  from public.school_data
  where school_id = p_school_id
  limit 1;

  if v_payload is null then
    return jsonb_build_object('ok', false, 'error', 'Aucune donnée scolaire');
  end if;

  return jsonb_build_object('ok', true, 'data', v_payload);
end;
$$;

grant execute on function public.get_school_data_admin(uuid, text) to anon;
grant execute on function public.get_school_data_admin(uuid, text) to authenticated;

create or replace function public.save_school_data_admin(p_school_id uuid, p_admin_code text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_root boolean := false;
  v_ief_id uuid;
  v_allowed boolean := false;
  v_exists boolean;
  v_version int;
begin
  select exists (
    select 1 from public.ief_config
    where key = 'admin_code' and value = p_admin_code
  ) into v_root;

  if v_root then
    v_allowed := true;
  else
    select i.id into v_ief_id
    from public.iefs i
    where i.code_admin = p_admin_code and i.actif is true
    limit 1;

    if v_ief_id is null then
      select a.ief_id into v_ief_id
      from public.admins a
      where a.code = p_admin_code and a.actif is true and a.role = 'admin'
      limit 1;
    end if;

    v_allowed := v_ief_id is not null and exists (
      select 1 from public.schools s
      where s.id = p_school_id and s.ief_id = v_ief_id
    );
  end if;

  if not v_allowed then
    return jsonb_build_object('ok', false, 'error', 'Enregistrement administrateur refusé');
  end if;

  select exists (
    select 1 from public.school_data where school_id = p_school_id
  ) into v_exists;

  if v_exists then
    update public.school_data
    set payload = p_payload,
        version = version + 1,
        updated_at = now()
    where school_id = p_school_id
    returning version into v_version;
  else
    insert into public.school_data (school_id, payload, version, updated_at)
    values (p_school_id, p_payload, 1, now())
    returning version into v_version;
  end if;

  return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;

grant execute on function public.save_school_data_admin(uuid, text, jsonb) to anon;
grant execute on function public.save_school_data_admin(uuid, text, jsonb) to authenticated;


-- ------------------------------------------------------------
-- 8) ACCÈS DES COMPTES DU PERSONNEL
--    Les codes du personnel ne sont jamais retournés dans la liste publique.
--    Ces RPC permettent aux comptes enseignant, vigile, comptable et secrétaire
--    de charger et sauvegarder l'école après authentification.
-- ------------------------------------------------------------
create or replace function public.get_school_data_staff(p_school_id uuid, p_staff_id text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_personnel jsonb;
  v_staff jsonb;
  v_role text;
begin
  select payload into v_payload from public.school_data where school_id = p_school_id limit 1;
  if v_payload is null then raise exception 'Données scolaires introuvables'; end if;
  v_personnel := coalesce(v_payload->'personnel', '[]'::jsonb);
  select value into v_staff from jsonb_array_elements(v_personnel) value where value->>'id' = p_staff_id limit 1;
  if v_staff is null or coalesce(v_staff->>'code', '') <> coalesce(p_code, '') then raise exception 'Code personnel incorrect'; end if;
  v_role := coalesce(v_staff->>'role', '');
  if v_role not in ('Enseignant(e)', 'Vigile', 'Comptable/Gestionnaire', 'Secrétaire') then raise exception 'Rôle non autorisé'; end if;
  return jsonb_build_object('ok', true, 'data', v_payload);
end;
$$;

grant execute on function public.get_school_data_staff(uuid, text, text) to anon;
grant execute on function public.get_school_data_staff(uuid, text, text) to authenticated;

create or replace function public.save_school_data_staff(p_school_id uuid, p_staff_id text, p_code text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current jsonb;
  v_personnel jsonb;
  v_staff jsonb;
  v_role text;
  v_version integer;
begin
  select payload, version into v_current, v_version from public.school_data where school_id = p_school_id limit 1;
  v_personnel := coalesce(v_current->'personnel', '[]'::jsonb);
  select value into v_staff from jsonb_array_elements(v_personnel) value where value->>'id' = p_staff_id limit 1;
  if v_staff is null or coalesce(v_staff->>'code', '') <> coalesce(p_code, '') then raise exception 'Code personnel incorrect'; end if;
  v_role := coalesce(v_staff->>'role', '');
  if v_role not in ('Enseignant(e)', 'Vigile', 'Comptable/Gestionnaire', 'Secrétaire') then raise exception 'Rôle non autorisé'; end if;
  update public.school_data
     set payload = p_payload, version = coalesce(v_version, 0) + 1, updated_at = now()
   where school_id = p_school_id;
  return jsonb_build_object('ok', true, 'version', coalesce(v_version, 0) + 1);
end;
$$;

grant execute on function public.save_school_data_staff(uuid, text, text, jsonb) to anon;
grant execute on function public.save_school_data_staff(uuid, text, text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 9) LISTE PUBLIQUE MINIMALE DU PERSONNEL POUR LA CONNEXION
-- ------------------------------------------------------------
create or replace function public.get_school_personnel(p_school_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_personnel jsonb := '[]'::jsonb;
  v_p jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  select payload into v_payload from public.school_data where school_id = p_school_id limit 1;
  v_personnel := coalesce(v_payload->'personnel', '[]'::jsonb);
  for v_p in select * from jsonb_array_elements(v_personnel)
  loop
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_p->>'id', 'prenom', v_p->>'prenom', 'nom', v_p->>'nom', 'role', v_p->>'role'));
  end loop;
  return jsonb_build_object('ok', true, 'personnel', v_out);
end;
$$;

grant execute on function public.get_school_personnel(uuid) to anon;
grant execute on function public.get_school_personnel(uuid) to authenticated;

-- Les fonctions précédentes sont idempotentes et peuvent être rejouées.

-- FIN DES RPC COMPTES DU PERSONNEL

-- ------------------------------------------------------------
