-- ============================================================
--  EduLink Pro — Ajout colonne cycles aux groupes scolaires
--  À exécuter dans l'éditeur SQL de Supabase.
--  Idempotent.
-- ============================================================

-- Ajoute la colonne cycles (tableau text) à la table iefs.
-- Un groupe scolaire couvre 2 à 5 cycles.
ALTER TABLE public.iefs
  ADD COLUMN IF NOT EXISTS cycles text[] DEFAULT '{}';

COMMENT ON COLUMN public.iefs.cycles IS 'Cycles couverts par le groupe scolaire (ex: {elementaire,moyen,secondaire}). Min 2, max 5.';
