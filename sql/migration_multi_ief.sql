-- ============================================================
--  SYGENOP — MIGRATION MULTI-IEF (script complet & idempotent)
--  À exécuter UNE FOIS dans l'éditeur SQL de Supabase.
--  Le script peut être relancé sans risque (IF NOT EXISTS).
-- ============================================================

-- ------------------------------------------------------------
-- 1) TABLE "iefs" — inspections décentralisées
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
-- 2) TABLE "admins" — comptes IEF / Administrateurs IEF
--    (avec rôle et rattachement optionnel à une IEF)
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

-- Compatibilité : si la table admins existait déjà (ancienne version
-- sans role/ief_id), on ajoute ces colonnes sans les dupliquer.
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
-- 5) Row Level Security — accès via l'API anon (même modèle
--    que le reste de l'application SYGENOP)
-- ------------------------------------------------------------
alter table public.iefs enable row level security;
drop policy if exists "iefs_anon_all" on public.iefs;
create policy "iefs_anon_all" on public.iefs for all to anon using (true) with check (true);

alter table public.admins enable row level security;
drop policy if exists "admins_anon_all" on public.admins;
create policy "admins_anon_all" on public.admins for all to anon using (true) with check (true);

alter table public.ief_config enable row level security;
drop policy if exists "ief_config_anon_all" on public.ief_config;
create policy "ief_config_anon_all" on public.ief_config for all to anon using (true) with check (true);

-- ------------------------------------------------------------
-- 6) Valeurs par défaut (à personnaliser)
-- ------------------------------------------------------------
insert into public.ief_config (key, value) values ('admin_code', 'ADMIN-2025') on conflict (key) do nothing;
insert into public.ief_config (key, value) values ('ief_code', 'IEF-DAKAR') on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 7) IEF GRAND DAKAR par défaut (l'IEF historique du système)
--    Les écoles existantes sans ief_id appartiennent à cette IEF.
--    On l'insère une seule fois (si aucune IEF nommée "GRAND DAKAR" n'existe).
-- ------------------------------------------------------------
insert into public.iefs (nom, code_lecture, code_admin, actif)
select 'IEF GRAND DAKAR', 'IEF-DAKAR', 'ADMIN-2025', true
where not exists (
  select 1 from public.iefs where upper(nom) like upper('%GRAND DAKAR%')
);

-- ============================================================
--  FIN DE LA MIGRATION
--  Rechargez ensuite la page SYGENOP (F5).
-- ============================================================

