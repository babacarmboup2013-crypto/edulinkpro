-- ============================================================================
-- migration_payload_version.sql
-- ----------------------------------------------------------------------------
-- PROBL�ME CORRIG�
--   Depuis migration_rate_limit.sql, les fonctions de LECTURE
--   (get_school_data, get_school_data_admin, get_school_data_staff) ne
--   renvoient plus le num�ro de VERSION de la ligne school_data. Le client
--   retombe alors sur payload.__version (absent du blob, car il est retir�
--   avant chaque sauvegarde) � il croit �tre en version 1.
--
--   Chaque �criture (personnel notamment) part donc avec un
--   p_expected_version = 1 alors que la vraie colonne version est plus
--   grande � "Conflit de version" � l'�criture est ABANDONN�E.
--   Cons�quence : une demande d'absence / d'attestation envoy�e par un
--   agent n'arrive JAMAIS au serveur et dispara�t apr�s rechargement (F5).
--
-- CORRECTIF
--   1) get_school_data / get_school_data_admin / get_school_data_staff
--      renvoient � nouveau la colonne `version` (m�mes signatures que les
--      versions actuellement d�ploy�es : CREATE OR REPLACE les remplace).
--   2) save_school_data / save_school_data_admin / save_school_data_staff
--      (signatures � 5 arguments = celles appel�es par l'application)
--      enregistrent __version DANS le payload, pour que tout lecteur
--      dispose d'un num�ro de version v�ridique m�me si une lecture ne
--      fournit pas encore la cl� `version`.
--
-- EX�CUTION : appliquer ce fichier dans l'�diteur SQL Supabase
-- (Project � SQL Editor � New query � Run).
-- ============================================================================

-- ------------------------------------------------------------
-- 1) LECTURE �cole (directeur) : renvoie la version
-- ------------------------------------------------------------
create or replace function public.get_school_data(p_school_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

grant execute on function public.get_school_data(uuid, text) to anon;
grant execute on function public.get_school_data(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 2) LECTURE administrateur (IEF / Super Admin) : renvoie la version
-- ------------------------------------------------------------
create or replace function public.get_school_data_admin(p_school_id uuid, p_admin_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

grant execute on function public.get_school_data_admin(uuid, text) to anon;
grant execute on function public.get_school_data_admin(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3) LECTURE personnel : renvoie la version (codes toujours masqu�s)
-- ------------------------------------------------------------
create or replace function public.get_school_data_staff(p_school_id uuid, p_staff_id text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

grant execute on function public.get_school_data_staff(uuid, text, text) to anon;
grant execute on function public.get_school_data_staff(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- 4) SAUVEGARDE �cole : verrouillage optimiste + __version dans le payload
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
  v_current_version := coalesce(v_current_version, 0);

  if v_exists and p_expected_version is not null and p_expected_version <> v_current_version then
    return jsonb_build_object(
      'ok', false,
      'error', 'Conflit de version : ces données ont été modifiées entretemps par quelqu''un d''autre. Rechargez la page puis refaites votre action.',
      'conflict', true,
      'server_version', v_current_version
    );
  end if;

  -- Persiste __version DANS le payload : tout lecteur aura un numéro
  -- véridique même si la RPC de lecture ne renvoie pas (encore) `version`.
  p_payload := jsonb_set(coalesce(p_payload, '{}'::jsonb), '{__version}', to_jsonb(v_current_version + 1));

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

grant execute on function public.save_school_data(uuid, text, jsonb, integer) to anon;
grant execute on function public.save_school_data(uuid, text, jsonb, integer) to authenticated;

-- ------------------------------------------------------------
-- 5) SAUVEGARDE administrateur : verrouillage optimiste + __version
-- ------------------------------------------------------------
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

  select exists (
    select 1 from public.school_data where school_id = p_school_id
  ) into v_exists;

  select version into v_current_version from public.school_data where school_id = p_school_id;
  v_current_version := coalesce(v_current_version, 0);

  if v_exists and p_expected_version is not null and p_expected_version <> v_current_version then
    return jsonb_build_object(
      'ok', false,
      'error', 'Conflit de version : ces données ont été modifiées entretemps par quelqu''un d''autre. Rechargez la page puis refaites votre action.',
      'conflict', true,
      'server_version', v_current_version
    );
  end if;

  p_payload := jsonb_set(coalesce(p_payload, '{}'::jsonb), '{__version}', to_jsonb(v_current_version + 1));

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

grant execute on function public.save_school_data_admin(uuid, text, jsonb, integer) to anon;
grant execute on function public.save_school_data_admin(uuid, text, jsonb, integer) to authenticated;

-- ------------------------------------------------------------
-- 6) SAUVEGARDE personnel : verrouillage optimiste + __version
--    (pr�serve TOUJOURS le bloc personnel stock�)
-- ------------------------------------------------------------
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
  v_version := coalesce(v_version, 0);

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

  if p_expected_version is not null and v_version > 0 and p_expected_version <> v_version then
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
  p_payload := jsonb_set(p_payload, '{__version}', to_jsonb(v_version + 1));

  update public.school_data
     set payload = p_payload, version = v_version + 1, updated_at = now()
   where school_id = p_school_id;
  return jsonb_build_object('ok', true, 'version', v_version + 1);
end;
$function$;

grant execute on function public.save_school_data_staff(uuid, text, text, jsonb, integer) to anon;
grant execute on function public.save_school_data_staff(uuid, text, text, jsonb, integer) to authenticated;