-- ============================================================
--  EduLink Pro — CORRECTIF DU VERROUILLAGE DE CONNEXION (rate limiting)
--  À exécuter dans l'éditeur SQL de Supabase. Idempotent.
--
--  Problèmes corrigés (constatés sur la base de production) :
--   1) Les échecs s'ACCUMULAIENT SANS LIMITE DE TEMPS : 5 fautes de frappe
--      étalées sur plusieurs jours suffisaient à verrouiller 15 min.
--   2) Le plafond « par école » (documenté : 20 essais / 15 min) se
--      déclenchait en réalité à 5 échecs, TOUS UTILISATEURS CONFONDUS :
--      quelques fautes de frappe verrouillaient l'école entière, même
--      pour ceux qui saisissaient le BON code.
--   3) Après expiration d'un verrou, le premier échec suivant
--      re-verrouillait immédiatement 15 min de plus.
--   4) _rl_remaining_minutes exécutait un DELETE à CHAQUE appel (donc à
--      chaque connexion / chargement) : écriture inutile, ralentit la base.
--
--  Nouvelle règle : fenêtre glissante de 15 min. Par code saisi : 5 échecs
--  → verrou 15 min (inchangé). Par école : 20 échecs / 15 min.
--  Les signatures des fonctions existantes ne changent pas.
-- ============================================================

-- 1) Nettoyage opportuniste RARE (≈ 2 % des appels) au lieu d'un DELETE à chaque appel
create or replace function public._rl_remaining_minutes(p_identifier text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min integer;
begin
  if random() < 0.02 then
    delete from public.login_attempts where last_attempt < now() - interval '2 days';
  end if;

  select ceil(extract(epoch from (locked_until - now())) / 60)::integer
    into v_min
  from public.login_attempts
  where identifier = p_identifier and locked_until is not null and locked_until > now()
  limit 1;

  return coalesce(v_min, 0);
end;
$$;

-- 2) Échec avec FENÊTRE GLISSANTE et seuil paramétrable
create or replace function public._rl_fail_n(p_identifier text, p_max integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.login_attempts as la (identifier, fails, last_attempt)
  values (p_identifier, 1, now())
  on conflict (identifier) do update
    set fails = case
          when la.locked_until is not null and la.locked_until > now() then la.fails          -- déjà verrouillé
          when la.locked_until is not null and la.locked_until <= now() then 1                -- verrou expiré : on repart de 1
          when la.last_attempt < now() - interval '15 minutes' then 1                         -- fenêtre expirée
          else la.fails + 1 end,
        locked_until = case
          when la.locked_until is not null and la.locked_until > now() then la.locked_until
          when (case when la.locked_until is not null and la.locked_until <= now() then 1
                     when la.last_attempt < now() - interval '15 minutes' then 1
                     else la.fails + 1 end) >= p_max
            then now() + interval '15 minutes'
          else null end,
        last_attempt = now();
end;
$$;

-- 3) _rl_fail (5 essais / 15 min) devient un cas particulier
create or replace function public._rl_fail(p_identifier text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._rl_fail_n(p_identifier, 5);
end;
$$;

-- 4) Connexion école : plafond par école = 20 échecs / 15 min (et non plus 5)
create or replace function public.check_school_code(p_school_id uuid, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key     text := 'school:' || coalesce(p_school_id::text, '') || ':' || md5(lower(trim(coalesce(p_code, ''))));
  v_school  text := 'school:' || coalesce(p_school_id::text, '');
  v_ok      boolean;
begin
  -- Plafond par école (20 échecs / 15 min, tous codes confondus)
  if public._rl_is_locked(v_school) then
    raise exception 'Trop de tentatives pour cette école. Réessayez dans % minute(s).',
      public._rl_remaining_minutes(v_school);
  end if;

  -- Verrou par code précis (5 échecs / 15 min)
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
    perform public._rl_fail_n(v_school, 20);
  end if;
  return coalesce(v_ok, false);
end;
$$;

grant execute on function public.check_school_code(uuid, text) to anon;
grant execute on function public.check_school_code(uuid, text) to authenticated;
revoke execute on function public._rl_fail_n(text, integer) from anon, authenticated;
