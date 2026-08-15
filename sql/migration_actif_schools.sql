-- ============================================================
--  SYGENOP — MIGRATION « ACTIF » (colonne actif sur schools)
--  À exécuter UNE FOIS dans l'éditeur SQL de Supabase.
--  Idempotent : peut être relancé sans risque (IF NOT EXISTS).
--  Ajoute la colonne `actif` (active/désactivée) à la table schools
--  PUIS recharge le cache du schéma PostgREST pour que la colonne
--  soit immédiatement utilisable (lecture ET écriture).
-- ============================================================

-- 1) Ajoute la colonne actif (par défaut true = école active)
alter table public.schools add column if not exists actif boolean not null default true;

-- 2) Index éventuel sur le statut actif (pour les filtres rapides)
create index if not exists idx_schools_actif on public.schools(actif);

-- 3) FORCE le rechargement du cache du schéma PostgREST.
--    Sans cette étape, l'API REST ne voit pas la nouvelle colonne
--    et rejette les écritures (PATCH) avec :
--    « Could not find the 'actif' column of 'schools' in the schema cache »
select pg_notify('pgrst', 'reload schema');

-- ============================================================
--  FIN DE LA MIGRATION
--  Rechargez ensuite la page SYGENOP (F5).
-- ============================================================
