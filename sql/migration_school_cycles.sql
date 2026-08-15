-- SYGENOP — Ajout du cycle scolaire aux écoles
-- À exécuter une seule fois dans Supabase > SQL Editor.
-- Le script est idempotent : il peut être relancé sans risque.

alter table public.schools add column if not exists cycle text;
create index if not exists idx_schools_cycle on public.schools(cycle);

-- Rend immédiatement la nouvelle colonne visible par l'API REST de Supabase.
select pg_notify('pgrst', 'reload schema');
