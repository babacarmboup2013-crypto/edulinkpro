-- ================================================================
-- MIGRATION : verrouillage optimiste sur school_data.payload
-- Déjà appliquée sur le projet Supabase udiyczpcrannhwyarqjx.
--
-- AVANT : chaque sauvegarde (save_school_data / _admin / _staff)
-- écrasait tout le bloc JSON de l'école sans jamais vérifier qu'il
-- n'avait pas changé entretemps. Deux utilisateurs sauvegardant
-- presque en même temps (ex. un enseignant qui fait l'appel pendant
-- que la direction modifie une fiche personnel) pouvaient s'écraser
-- silencieusement l'un l'autre — aucune erreur, perte de données
-- invisible.
--
-- APRÈS : le client doit désormais fournir la version qu'il a lue
-- (p_expected_version). Si la version en base a changé depuis, la
-- sauvegarde est REFUSÉE (aucune écriture) avec un message explicite
-- plutôt que d'écraser. Les fonctions de lecture (get_school_data*)
-- renvoient désormais aussi le numéro de version courant pour que le
-- client puisse le mémoriser puis le renvoyer à la sauvegarde
-- suivante.
--
-- Rétrocompatible : p_expected_version est optionnel (défaut NULL).
-- Un appelant qui ne le fournit pas garde l'ancien comportement
-- (écrasement direct) — la protection ne devient active qu'une fois
-- le nouveau frontend déployé et envoyant systématiquement la
-- version. PostgreSQL traite les nouvelles signatures (4 arguments)
-- comme des SURCHARGES distinctes des anciennes (3 arguments) : les
-- deux coexistent tant que les anciennes ne sont pas explicitement
-- supprimées (DROP FUNCTION ... (3 arguments)), à faire une fois le
-- nouveau client confirmé déployé, pour rendre la protection
-- obligatoire.
-- ================================================================

-- ------------------------------------------------------------
-- 1) LECTURE : renvoyer la version courante
-- ------------------------------------------------------------
create or replace function public.get_school_data(p_school_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key     text := 'school:' || coalesce(p_school_id::text, '');
  v_payload jsonb;
  v_version integer;
  v_ok      boolean;
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

  select payload, version into v_payload, v_version
  from public.school_data
  where school_id = p_school_id
  limit 1;

  if v_payload is null then
    return jsonb_build_object('ok', false, 'error', 'Aucune donnée');
  end if;

  return jsonb_build_object('ok', true, 'data', v_payload, 'version', v_version);
end;
$function$;

create or replace function public.get_school_data_admin(p_school_id uuid, p_admin_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key     text := 'admin:' || md5(coalesce(p_admin_code, ''));
  v_root    boolean := false;
  v_ief_id  uuid;
  v_allowed boolean := false;
  v_payload jsonb;
  v_version integer;
  v_min     integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    raise exception 'Trop de tentatives. Réessayez dans % minute(s).', v_min;
  end if;

  select exists (
    select 1 from public.ief_config
    where key = 'admin_code' and value = p_admin_code and value <> ''
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
    perform public._rl_fail(v_key);
    return jsonb_build_object('ok', false, 'error', 'Accès administrateur refusé');
  end if;
  perform public._rl_success(v_key);

  select payload, version into v_payload, v_version
  from public.school_data
  where school_id = p_school_id
  limit 1;

  if v_payload is null then
    return jsonb_build_object('ok', false, 'error', 'Aucune donnée scolaire');
  end if;

  return jsonb_build_object('ok', true, 'data', v_payload, 'version', v_version);
end;
$function$;

create or replace function public.get_school_data_staff(p_school_id uuid, p_staff_id text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key      text := 'staff:' || coalesce(p_school_id::text, '') || ':' || coalesce(p_staff_id, '');
  v_payload  jsonb;
  v_version  integer;
  v_personnel jsonb;
  v_clean    jsonb;
  v_staff    jsonb;
  v_role     text;
begin
  if public._rl_is_locked(v_key) then
    raise exception 'Trop de tentatives. Réessayez dans % minute(s).',
      public._rl_remaining_minutes(v_key);
  end if;

  select payload, version into v_payload, v_version from public.school_data where school_id = p_school_id limit 1;
  if v_payload is null then raise exception 'Données scolaires introuvables'; end if;

  v_personnel := coalesce(v_payload -> 'personnel', '[]'::jsonb);
  select value into v_staff from jsonb_array_elements(v_personnel) value where value ->> 'id' = p_staff_id limit 1;
  if v_staff is null or coalesce(v_staff ->> 'code', '') = '' 
     or lower(trim(coalesce(v_staff ->> 'code', ''))) <> lower(trim(coalesce(p_code, ''))) then
    perform public._rl_fail(v_key);
    raise exception 'Code personnel incorrect';
  end if;
  perform public._rl_success(v_key);

  v_role := coalesce(v_staff ->> 'role', '');
  if v_role not in ('Enseignant(e)', 'Vigile', 'Comptable/Gestionnaire', 'Secrétaire', 'Directeur Pédagogique', 'Assistant(e) Pédagogique') then
    raise exception 'Rôle non autorisé';
  end if;

  -- Masque les codes : l'appelant garde uniquement le sien.
  select coalesce(jsonb_agg(
           case when elem ->> 'id' = p_staff_id then elem else elem - 'code' end
         ), '[]'::jsonb)
    into v_clean
  from jsonb_array_elements(v_personnel) elem;

  return jsonb_build_object('ok', true, 'data', jsonb_set(v_payload, '{personnel}', v_clean), 'version', v_version);
end;
$function$;

-- ------------------------------------------------------------
-- 2) ÉCRITURE : refuser si la version a changé entretemps
-- ------------------------------------------------------------
create or replace function public.save_school_data(p_school_id uuid, p_code text, p_payload jsonb, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key         text := 'school:' || coalesce(p_school_id::text, '');
  v_ok          boolean;
  v_exists      boolean;
  v_current_version int;
  v_new_version int;
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

  select version into v_current_version from public.school_data where school_id = p_school_id;
  v_exists := v_current_version is not null;

  if v_exists and p_expected_version is not null and p_expected_version <> v_current_version then
    return jsonb_build_object(
      'ok', false,
      'error', 'Conflit de version : ces données ont été modifiées entretemps par quelqu''un d''autre. Rechargez la page puis refaites votre action.',
      'conflict', true,
      'server_version', v_current_version
    );
  end if;

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
$function$;

create or replace function public.save_school_data_admin(p_school_id uuid, p_admin_code text, p_payload jsonb, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key     text := 'admin:' || md5(coalesce(p_admin_code, ''));
  v_root    boolean := false;
  v_ief_id  uuid;
  v_allowed boolean := false;
  v_exists  boolean;
  v_current_version int;
  v_version int;
  v_min     integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    raise exception 'Trop de tentatives. Réessayez dans % minute(s).', v_min;
  end if;

  select exists (
    select 1 from public.ief_config
    where key = 'admin_code' and value = p_admin_code and value <> ''
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
    perform public._rl_fail(v_key);
    return jsonb_build_object('ok', false, 'error', 'Enregistrement administrateur refusé');
  end if;
  perform public._rl_success(v_key);

  select version into v_current_version from public.school_data where school_id = p_school_id;
  v_exists := v_current_version is not null;

  if v_exists and p_expected_version is not null and p_expected_version <> v_current_version then
    return jsonb_build_object(
      'ok', false,
      'error', 'Conflit de version : ces données ont été modifiées entretemps par quelqu''un d''autre. Rechargez la page puis refaites votre action.',
      'conflict', true,
      'server_version', v_current_version
    );
  end if;

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
$function$;

create or replace function public.save_school_data_staff(p_school_id uuid, p_staff_id text, p_code text, p_payload jsonb, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key      text := 'staff:' || coalesce(p_school_id::text, '') || ':' || coalesce(p_staff_id, '');
  v_current  jsonb;
  v_personnel jsonb;
  v_staff    jsonb;
  v_role     text;
  v_version  integer;
begin
  if public._rl_is_locked(v_key) then
    raise exception 'Trop de tentatives. Réessayez dans % minute(s).',
      public._rl_remaining_minutes(v_key);
  end if;

  select payload, version into v_current, v_version from public.school_data where school_id = p_school_id limit 1;
  v_personnel := coalesce(v_current -> 'personnel', '[]'::jsonb);

  select value into v_staff from jsonb_array_elements(v_personnel) value where value ->> 'id' = p_staff_id limit 1;
  if v_staff is null or coalesce(v_staff ->> 'code', '') = ''
     or lower(trim(coalesce(v_staff ->> 'code', ''))) <> lower(trim(coalesce(p_code, ''))) then
    perform public._rl_fail(v_key);
    raise exception 'Code personnel incorrect';
  end if;
  perform public._rl_success(v_key);

  v_role := coalesce(v_staff ->> 'role', '');
  if v_role not in ('Enseignant(e)', 'Vigile', 'Comptable/Gestionnaire', 'Secrétaire', 'Directeur Pédagogique', 'Assistant(e) Pédagogique') then
    raise exception 'Rôle non autorisé';
  end if;

  if p_expected_version is not null and v_version is not null and p_expected_version <> v_version then
    return jsonb_build_object(
      'ok', false,
      'error', 'Conflit de version : ces données ont été modifiées entretemps par quelqu''un d''autre. Rechargez la page puis refaites votre action.',
      'conflict', true,
      'server_version', v_version
    );
  end if;

  -- Le bloc personnel est TOUJOURS celui du serveur : pas d'écrasement,
  -- pas de création de compte, pas de destruction de codes via un payload
  -- masqué renvoyé tel quel par le client.
  p_payload := jsonb_set(coalesce(p_payload, '{}'::jsonb), '{personnel}', v_personnel, true);

  update public.school_data
     set payload = p_payload, version = coalesce(v_version, 0) + 1, updated_at = now()
   where school_id = p_school_id;
  return jsonb_build_object('ok', true, 'version', coalesce(v_version, 0) + 1);
end;
$function$;
