-- ============================================================
--  SYGENOP / EduLink Pro — SÉCURISATION DES CODES D'ACCÈS
--  À exécuter UNE FOIS dans l'éditeur SQL de Supabase.
--  Idempotent : peut être relancé sans risque (DROP ... IF EXISTS).
--
--  Objectif :
--  Les codes d'accès (écoles, IEF, admins) étaient stockés dans des
--  colonnes lisibles par le rôle "anon". Comme la clé "anon" est
--  embarquée dans le code client (publique par conception), n'importe
--  qui pouvait appeler l'API et récupérer ces codes.
--
--  Cette migration :
--   1) Révoque la lecture directe des colonnes sensibles pour anon.
--   2) Crée des fonctions RPC SECURITY DEFINER qui vérifient les codes
--      SANS les renvoyer (elles ne retournent qu'un booléen / rôle).
--      C'est le seul moyen de vérifier un secret sans l'exposer.
-- ============================================================

-- ------------------------------------------------------------
-- 1) VÉRIFICATION DU CODE ÉCOLE
--    Retourne true si (school_id, code) correspondent à une école
--    active. Ne renvoie JAMAIS le code stocké.
-- ------------------------------------------------------------
create or replace function public.check_school_code(p_school_id uuid, p_code text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.schools
    where id = p_school_id
      and actif is not false
      and code = p_code
  );
$$;

-- ------------------------------------------------------------
-- 2) VÉRIFICATION DU CODE IEF (lecture seule)
--    Retourne { ok, nom, ief_id } ou { ok: false }.
--    Vérifie :
--      - le code partagé historique (ief_config.ief_code)
--      - la table iefs.code_lecture
--      - la table admins (comptes de lecture)
-- ------------------------------------------------------------
create or replace function public.check_ief_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg text;
  v_row  public.iefs%rowtype;
  v_admin record;
begin
  -- 1) Code partagé historique
  select value into v_cfg
  from public.ief_config
  where key = 'ief_code';
  if coalesce(v_cfg, 'IEF-DAKAR') = p_code then
    return jsonb_build_object(
      'ok', true,
      'nom', 'IEF GRAND DAKAR',
      'ief_id', null
    );
  end if;

  -- 2) IEF décentralisée (table iefs)
  select * into v_row
  from public.iefs
  where code_lecture = p_code and actif is true
  limit 1;
  if found then
    return jsonb_build_object('ok', true, 'nom', v_row.nom, 'ief_id', v_row.id);
  end if;

  -- 3) Compte admins (lecture IEF)
  select id, nom, ief_id into v_admin
  from public.admins
  where code = p_code and actif is true
  limit 1;
  if found then
    return jsonb_build_object('ok', true, 'nom', v_admin.nom, 'ief_id', v_admin.ief_id);
  end if;

  return jsonb_build_object('ok', false);
end;
$$;

-- ------------------------------------------------------------
-- 3) VÉRIFICATION DU CODE SUPER ADMIN
--    Retourne { ok, nom, ief_id, ief_name } ou { ok: false }.
--    Vérifie :
--      - le code maître (ief_config.admin_code)
--      - la table iefs.code_admin
--      - la table admins (rôle admin)
-- ------------------------------------------------------------
create or replace function public.check_admin_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg text;
  v_ief  public.iefs%rowtype;
  v_admin record;
begin
  -- 1) Code maître partagé
  select value into v_cfg
  from public.ief_config
  where key = 'admin_code';
  if coalesce(v_cfg, '') = p_code then
    return jsonb_build_object('ok', true, 'nom', 'Super Admin', 'ief_id', null, 'ief_name', null);
  end if;

  -- 2) Administrateur IEF décentralisé (iefs.code_admin)
  select * into v_ief
  from public.iefs
  where code_admin = p_code and actif is true
  limit 1;
  if found then
    return jsonb_build_object('ok', true, 'nom', v_ief.nom, 'ief_id', v_ief.id, 'ief_name', v_ief.nom);
  end if;

  -- 3) Compte admins (rôle admin)
  select id, nom, ief_id into v_admin
  from public.admins
  where code = p_code and actif is true and role = 'admin'
  limit 1;
  if found then
    return jsonb_build_object('ok', true, 'nom', v_admin.nom, 'ief_id', v_admin.ief_id, 'ief_name', v_admin.nom);
  end if;

  return jsonb_build_object('ok', false);
end;
$$;

-- ------------------------------------------------------------
-- 4) RÉVOCATION COLONNES SENSIBLES (rôle anon)
--    L'anon ne peut plus lire les codes en clair. Seules les
--    fonctions SECURITY DEFINER ci-dessus peuvent y accéder.
--    NB : on conserve les autres colonnes (id, nom, type, cycle,
--    actif, ief_id, directeur) pour que la liste des écoles reste
--    utilisable côté client.
-- ------------------------------------------------------------
revoke select (code) on public.schools from anon;
revoke select (code_lecture, code_admin) on public.iefs from anon;
revoke select (code) on public.admins from anon;
revoke select (value) on public.ief_config from anon;

-- ------------------------------------------------------------
-- 5) RLS : limite les lectures directes de ces tables pour anon.
--    On interdit la lecture de toute la ligne (les codes ne sont
--    plus accessibles), mais on garde une politique de lecture
--    restreinte aux colonnes utiles via les vues ci-dessous.
-- ------------------------------------------------------------
-- schools : plus de lecture directe anon (la liste passe par une vue)
drop policy if exists "schools_anon_all" on public.schools;
create policy "schools_anon_read_public" on public.schools
  for select to anon
  using (actif is not false);

-- Pour les tables sensibles, on retire la politique "all" historique
-- et on n'autorise QUE les fonctions SECURITY DEFINER (qui tournent
-- avec le rôle du propriétaire, pas anon).
drop policy if exists "admins_anon_all" on public.admins;
drop policy if exists "iefs_anon_all" on public.iefs;
drop policy if exists "ief_config_anon_all" on public.ief_config;

alter table public.admins force row level security;
alter table public.iefs force row level security;
alter table public.ief_config force row level security;

-- ------------------------------------------------------------
-- 6) LISTE PUBLIQUE DES ÉCOLES (sans les codes)
--    Vue qui n'expose que les colonnes sûres pour l'écran de login.
-- ------------------------------------------------------------
create or replace view public.public_schools as
  select id, name, type, cycle, actif, ief_id
  from public.schools
  where actif is not false;

grant select on public.public_schools to anon;

-- ============================================================
--  FIN DE LA MIGRATION
--  Rechargez ensuite la page (F5).
-- ============================================================
