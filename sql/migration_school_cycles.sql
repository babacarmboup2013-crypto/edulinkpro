-- ============================================================
--  EduLink Pro — Cycles multiples sur les écoles (groupe scolaire)
--  À exécuter dans l'éditeur SQL de Supabase.
--  Idempotent.
--  ============================================================

-- Ajoute la colonne cycles (tableau text) à la table schools.
-- Une école simple = 1 cycle ; un groupe scolaire = 2 à 5 cycles.
ALTER TABLE public.schools
  ADD COLUMN IF NOT EXISTS cycles text[] DEFAULT '{}';

COMMENT ON COLUMN public.schools.cycles IS 'Cycles couverts par l''école (ex: {elementaire,moyen,secondaire}). Une école simple en a 1, un groupe scolaire en a 2 à 5.';