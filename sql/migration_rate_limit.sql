-- ============================================================
--  SYGENOP / EduLink Pro — RATE LIMITING SERVEUR + DURCISSEMENTS
--  À exécuter UNE FOIS dans l'éditeur SQL de Supabase.
--  Idempotent : peut être relancé sans risque.
--
--  Objectif :
--  Le verrouillage anti brute-force était purement client (localStorage),
--  donc contournable : un attaquant pouvait tester des codes sans limite
--  en appelant les RPC directement avec la clé anon (publique).
--
--  Cette migration :
--   1) Crée une table login_attempts + helpers SECURITY DEFINER et
--      applique un verrou serveur (5 échecs → blocage 15 min) sur
--      TOUTES les fonctions qui vérifient un secret.
--   2) Verrouille get_schools_overview (appelable par anon avec
--      p_ief_id NULL = statistiques de TOUTES les écoles, sans code).
--   3) Supprime le fallback "IEF-DAKAR" codé en dur dans check_ief_code.
--   4) get_school_data_staff ne renvoie PLUS les codes du personnel ;
--      save_school_data_staff préserve le bloc personnel existant.
--   5) Ajoute check_staff_code : vérification serveur du code personnel
--      pour l'écran de connexion (remplace la comparaison côté client).
--
--  NB : les Edge Functions (read-schools / admin-write) vérifient aussi
--  des codes mais leur code source est déployé à part — pensez à y
--  répercuter ce schéma de limitation quand c'est possible.
-- ============================================================

-- ------------------------------------------------------------
-- 1) TABLE login_attempts + HELPERS
--    Aucune policy RLS : inaccessible directement par anon/authenticated,
--    uniquement via les helpers SECURITY DEFINER ci-dessous.
-- ------------------------------------------------------------
create table if not exists public.login_attempts (
  identifier   text primary key,
  fails        integer not null default 0,
  locked_until timestamptz,
  last_attempt timestamptz not null default now()
);

alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;

-- Nombre de minutes restantes du verrou (0 = pas verrouillé).
create or replace function public._rl_remaining_minutes(p_identifier text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min integer;
begin
  -- Nettoyage opportuniste des vieilles lignes (> 2 jours).
  delete from public.login_attempts where last_attempt < now() - interval '2 days';

  select ceil(extract(epoch from (locked_until - now())) / 60)::integer
    into v_min
  from public.login_attempts
  where identifier = p_identifier and locked_until is not null and locked_until > now()
  limit 1;

  return coalesce(v_min, 0);
end;
$$;

create or replace function public._rl_is_locked(p_identifier text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return public._rl_remaining_minutes(p_identifier) > 0;
end;
$$;

-- Enregistre un échec ; bloque après MAX_RL_ATTEMPTS échecs consécutifs.
create or replace function public._rl_fail(p_identifier text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.login_attempts as la (identifier, fails, last_attempt)
  values (p_identifier, 1, now())
  on conflict (identifier) do update
    set fails        = case when la.locked_until is not null and la.locked_until <= now()
                            then 1                       -- verrou expiré → on repart de zéro
                            else la.fails + 1 end,
        locked_until = case when coalesce(la.fails, 0) + 1 >= 5
                             then now() + interval '15 minutes'
                             else la.locked_until end,
        last_attempt = now();
end;
$$;

-- Réinitialise le compteur après un succès.
create or replace function public._rl_success(p_identifier text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.login_attempts where identifier = p_identifier;
end;
$$;

revoke all on function public._rl_remaining_minutes(text) from anon, authenticated;
revoke all on function public._rl_is_locked(text) from anon, authenticated;
revoke all on function public._rl_fail(text) from anon, authenticated;
revoke all on function public._rl_success(text) from anon, authenticated;

-- ------------------------------------------------------------
-- 2) VÉRIFICATION DU CODE ÉCOLE (avec rate limiting)
-- ------------------------------------------------------------
create or replace function public.check_school_code(p_school_id uuid, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := 'school:' || coalesce(p_school_id::text, '');
  v_ok  boolean;
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

  if coalesce(v_ok, false) then
    perform public._rl_success(v_key);
  else
    perform public._rl_fail(v_key);
  end if;
  return coalesce(v_ok, false);
end;
$$;

grant execute on function public.check_school_code(uuid, text) to anon;
grant execute on function public.check_school_code(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3) VÉRIFICATION DU CODE IEF (rate limit + plus JAMAIS de fallback
--    codé en dur : si ief_config.ief_code est vide, aucune valeur
--    magique n'est acceptée)
-- ------------------------------------------------------------
create or replace function public.check_ief_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key  text := 'ief:' || md5(coalesce(p_code, ''));
  v_cfg  text;
  v_row  public.iefs%rowtype;
  v_admin record;
  v_min  integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    return jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  end if;

  -- 1) Code partagé historique (config obligatoirement non vide)
  select value into v_cfg
  from public.ief_config
  where key = 'ief_code';
  if v_cfg is not null and v_cfg <> '' and v_cfg = p_code then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', 'IEF CENTRALE', 'ief_id', null);
  end if;

  -- 2) IEF décentralisée (table iefs)
  select * into v_row
  from public.iefs
  where code_lecture = p_code and actif is true
  limit 1;
  if found then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', v_row.nom, 'ief_id', v_row.id);
  end if;

  -- 3) Compte admins (lecture IEF)
  select id, nom, ief_id into v_admin
  from public.admins
  where code = p_code and actif is true
  limit 1;
  if found then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', v_admin.nom, 'ief_id', v_admin.ief_id);
  end if;

  perform public._rl_fail(v_key);
  return jsonb_build_object('ok', false);
end;
$$;

grant execute on function public.check_ief_code(text) to anon;
grant execute on function public.check_ief_code(text) to authenticated;

-- ------------------------------------------------------------
-- 4) VÉRIFICATION DU CODE SUPER ADMIN (avec rate limiting)
-- ------------------------------------------------------------
create or replace function public.check_admin_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key   text := 'admin:' || md5(coalesce(p_code, ''));
  v_cfg   text;
  v_ief   public.iefs%rowtype;
  v_admin record;
  v_min   integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    return jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  end if;

  -- 1) Code maître partagé (config obligatoirement non vide)
  select value into v_cfg
  from public.ief_config
  where key = 'admin_code';
  if v_cfg is not null and v_cfg <> '' and v_cfg = p_code then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', 'Super Admin', 'ief_id', null, 'ief_name', null);
  end if;

  -- 2) Administrateur IEF décentralisé (iefs.code_admin)
  select * into v_ief
  from public.iefs
  where code_admin = p_code and actif is true
  limit 1;
  if found then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', v_ief.nom, 'ief_id', v_ief.id, 'ief_name', v_ief.nom);
  end if;

  -- 3) Compte admins (rôle admin)
  select id, nom, ief_id into v_admin
  from public.admins
  where code = p_code and actif is true and role = 'admin'
  limit 1;
  if found then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', v_admin.nom, 'ief_id', v_admin.ief_id, 'ief_name', v_admin.nom);
  end if;

  perform public._rl_fail(v_key);
  return jsonb_build_object('ok', false);
end;
$$;

grant execute on function public.check_admin_code(text) to anon;
grant execute on function public.check_admin_code(text) to authenticated;

-- ------------------------------------------------------------
-- 5) NOUVEAU : VÉRIFICATION DU CODE PERSONNEL (écran de connexion)
--    Compare côté serveur (le code n'est plus jamais envoyé au client).
--    Mêmes rôles autorisés que get_school_data_staff.
--    NB : certaines bases ont déjà un ancien check_staff_code avec un
--    type de retour différent (ex. jsonb) — CREATE OR REPLACE ne peut
--    pas changer un type de retour, on remplace donc proprement.
-- ------------------------------------------------------------
drop function if exists public.check_staff_code(uuid, text, text);

create or replace function public.check_staff_code(p_school_id uuid, p_staff_id text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key   text := 'staff:' || coalesce(p_school_id::text, '') || ':' || coalesce(p_staff_id, '');
  v_staff jsonb;
  v_ok    boolean;
begin
  if coalesce(p_code, '') = '' then
    return false;
  end if;

  if public._rl_is_locked(v_key) then
    raise exception 'Trop de tentatives. Réessayez dans % minute(s).',
      public._rl_remaining_minutes(v_key);
  end if;

  select value into v_staff
  from public.school_data sd,
       jsonb_array_elements(coalesce(sd.payload -> 'personnel', '[]'::jsonb)) value
  where sd.school_id = p_school_id
    and value ->> 'id' = p_staff_id
  limit 1;

  v_ok := v_staff is not null
    and coalesce(v_staff ->> 'code', '') <> ''
    and lower(trim(coalesce(v_staff ->> 'code', ''))) = lower(trim(p_code))
    and coalesce(v_staff ->> 'role', '') in (
      'Enseignant(e)', 'Vigile', 'Comptable/Gestionnaire',
      'Secrétaire', 'Directeur Pédagogique', 'Assistant(e) Pédagogique'
    );

  if v_ok then
    perform public._rl_success(v_key);
  else
    perform public._rl_fail(v_key);
  end if;
  return v_ok;
end;
$$;

grant execute on function public.check_staff_code(uuid, text, text) to anon;
grant execute on function public.check_staff_code(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- 6) LECTURE / ÉCRITURE PAR CODE ÉCOLE (avec rate limiting)
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

create or replace function public.save_school_data(p_school_id uuid, p_code text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key         text := 'school:' || coalesce(p_school_id::text, '');
  v_ok          boolean;
  v_exists      boolean;
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
-- 7) LECTURE / ÉCRITURE ADMIN (rate limiting par md5(code))
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
  v_key     text := 'admin:' || md5(coalesce(p_admin_code, ''));
  v_root    boolean := false;
  v_ief_id  uuid;
  v_allowed boolean := false;
  v_exists  boolean;
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

create or replace function public.init_school_data(p_school_id uuid, p_admin_code text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key     text := 'admin:' || md5(coalesce(p_admin_code, ''));
  v_cfg     text;
  v_exists  boolean;
  v_min     integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    raise exception 'Trop de tentatives. Réessayez dans % minute(s).', v_min;
  end if;

  select value into v_cfg from public.ief_config where key = 'admin_code';
  if v_cfg is null or v_cfg = '' or p_admin_code is distinct from v_cfg then
    perform public._rl_fail(v_key);
    return jsonb_build_object('ok', false, 'error', 'Accès refusé');
  end if;
  perform public._rl_success(v_key);

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
-- 8) LECTURE / ÉCRITURE STAFF :
--    a) rate limiting par école + membre
--    b) get_school_data_staff NE RENVOIE PLUS les codes du personnel
--       (sauf celui de l'appelant, qu'il connaît déjà)
--    c) save_school_data_staff PRÉSERVE le bloc personnel stocké :
--       un membre du personnel ne peut ni écraser ni créer de comptes,
--       et la sauvegarde d'un payload dont les codes ont été masqués
--       ne détruit plus les codes réels.
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
  v_personnel jsonb;
  v_clean    jsonb;
  v_staff    jsonb;
  v_role     text;
begin
  if public._rl_is_locked(v_key) then
    raise exception 'Trop de tentatives. Réessayez dans % minute(s).',
      public._rl_remaining_minutes(v_key);
  end if;

  select payload into v_payload from public.school_data where school_id = p_school_id limit 1;
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

  return jsonb_build_object('ok', true, 'data', jsonb_set(v_payload, '{personnel}', v_clean));
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

  -- Le bloc personnel est TOUJOURS celui du serveur : pas d'écrasement,
  -- pas de création de compte, pas de destruction de codes via un payload
  -- masqué renvoyé tel quel par le client.
  p_payload := jsonb_set(coalesce(p_payload, '{}'::jsonb), '{personnel}', v_personnel, true);

  update public.school_data
     set payload = p_payload, version = coalesce(v_version, 0) + 1, updated_at = now()
   where school_id = p_school_id;
  return jsonb_build_object('ok', true, 'version', coalesce(v_version, 0) + 1);
end;
$$;

grant execute on function public.save_school_data_staff(uuid, text, text, jsonb) to anon;
grant execute on function public.save_school_data_staff(uuid, text, text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 9) IDOR : get_schools_overview n'est utilisée par AUCUN client et
--    acceptait p_ief_id NULL (= statistiques de toutes les écoles)
--    sans aucune vérification. Exécution réservée à service_role
--    (tableaux de bord internes). Si un jour un client en a besoin,
--    ajouter un paramètre de vérification par code admin.
-- ------------------------------------------------------------
revoke all on function public.get_schools_overview(uuid, boolean) from anon, authenticated;

-- ============================================================
--  FIN DE LA MIGRATION
--  Rechargez ensuite la page (F5).
--  ⚠️ Mettez à jour l'application (JSX) en même temps : l'écran de
--  connexion du personnel utilise désormais check_staff_code.
-- ============================================================
