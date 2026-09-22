-- ============================================================
--  EduLink Pro — GROUPE SCOLAIRE : MIGRATION COMPLÈTE
--  À exécuter dans l'éditeur SQL de Supabase.
--  Idempotent : peut être relancé sans risque.
--
--  Cette migration crée TOUT ce qui est nécessaire :
--   1) Tables iefs, admins, ief_config (si absentes)
--   2) Colonne ief_id sur schools + cycles sur iefs
--   3) RLS sur les tables sensibles
--   4) Valeurs par défaut + IEF GRAND DAKAR
--   5) check_groupe_code — valide le code du Groupe scolaire
-- ============================================================

-- ------------------------------------------------------------
-- 1) TABLE "iefs" — Groupes scolaires (entités séparées)
-- ------------------------------------------------------------
create table if not exists public.iefs (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  code_lecture text not null unique,
  code_admin text not null unique,
  actif boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2) TABLE "admins" — Comptes Groupe scolaire
-- ------------------------------------------------------------
create table if not exists public.admins (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  code text not null unique,
  role text not null default 'ief',
  actif boolean not null default true,
  ief_id uuid references public.iefs(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.admins add column if not exists role text not null default 'ief';
alter table public.admins add column if not exists ief_id uuid references public.iefs(id) on delete set null;

-- ------------------------------------------------------------
-- 3) TABLE "schools" — colonnes manquantes
-- ------------------------------------------------------------
alter table public.schools add column if not exists ief_id uuid references public.iefs(id) on delete set null;
alter table public.schools add column if not exists directeur text;
alter table public.schools add column if not exists actif boolean not null default true;
alter table public.schools add column if not exists cycle text;
create index if not exists idx_schools_ief_id on public.schools(ief_id);
create index if not exists idx_schools_cycle on public.schools(cycle);

-- ------------------------------------------------------------
-- 4) TABLE "ief_config" — clé/valeur partagée
-- ------------------------------------------------------------
create table if not exists public.ief_config (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 5) Colonne cycles sur iefs (Groupe scolaire)
-- ------------------------------------------------------------
ALTER TABLE public.iefs ADD COLUMN IF NOT EXISTS cycles text[] DEFAULT '{}';

-- ------------------------------------------------------------
-- 6) RLS — AUCUN accès direct pour le rôle anon
-- ------------------------------------------------------------
alter table public.iefs enable row level security;
drop policy if exists "iefs_anon_all" on public.iefs;
drop policy if exists "iefs_anon_read" on public.iefs;

alter table public.admins enable row level security;
drop policy if exists "admins_anon_all" on public.admins;
drop policy if exists "admins_anon_read" on public.admins;

alter table public.ief_config enable row level security;
drop policy if exists "ief_config_anon_all" on public.ief_config;
drop policy if exists "ief_config_anon_read" on public.ief_config;

-- ------------------------------------------------------------
-- 7) Valeurs par défaut (PROVISOIRES)
-- ------------------------------------------------------------
insert into public.ief_config (key, value) values ('admin_code', 'ADMIN-2025') on conflict (key) do nothing;
insert into public.ief_config (key, value) values ('ief_code', 'IEF-DAKAR') on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 8) Groupe scolaire GRAND DAKAR par défaut
-- ------------------------------------------------------------
insert into public.iefs (nom, code_lecture, code_admin, actif)
select 'Groupe scolaire GRAND DAKAR', 'IEF-DAKAR', 'ADMIN-DAKAR', true
where not exists (
  select 1 from public.iefs where upper(nom) like upper('%GRAND DAKAR%')
);

-- ------------------------------------------------------------
-- 9) CHECK_GROUPE_CODE — Validation du code Groupe scolaire
--    Valide le code_lecture de la table iefs.
--    Retourne { ok, nom, ief_id } en cas de succès.
--    Rate limiting partagé (clé 'groupe:').
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_groupe_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key     text := 'groupe:' || md5(coalesce(p_code, ''));
  v_id      uuid;
  v_name    text;
  v_min     integer;
BEGIN
  v_min := public._rl_remaining_minutes(v_key);
  IF v_min > 0 THEN
    RETURN jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  END IF;

  SELECT id, nom INTO v_id, v_name
  FROM public.iefs
  WHERE code_lecture = p_code AND actif IS NOT FALSE
  LIMIT 1;

  IF v_id IS NULL THEN
    PERFORM public._rl_fail(v_key);
    RETURN jsonb_build_object('ok', false);
  END IF;

  PERFORM public._rl_success(v_key);
  RETURN jsonb_build_object('ok', true, 'nom', v_name, 'ief_id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_groupe_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_groupe_code(text) TO authenticated;

-- ============================================================
--  FIN DE LA MIGRATION
--  Appliquez puis rechargez la page (F5).
-- ============================================================
