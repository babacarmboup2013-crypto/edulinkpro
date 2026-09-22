-- ============================================================
--  EduLink Pro — ENTITÉS « GROUPE SCOLAIRE » (séparées de l'IEF)
--  À exécuter dans l'éditeur SQL de Supabase.
--  Idempotent : peut être relancé sans risque.
--
--  Crée la table groupes_scolaires (entité distincte de l'IEF /
--  circonscription). Chaque groupe scolaire a son propre code de
--  connexion (lecture seule), des cycles couverts, et regroupe
--  des écoles membres via schools.groupe_id.
--
--  Modifie ensuite check_groupe_code pour qu'elle valide le code
--  de la table groupes_scolaires (au lieu de iefs.code_lecture).
--
--  Étapes :
--   1) Table groupes_scolaires + RLS
--   2) Colonne groupe_id sur schools + index
--   3) RPC list_active_groupes
--   4) check_groupe_code → groupes_scolaires.code
--   5) Valeur par défaut : Groupe scolaire GRAND DAKAR
-- ============================================================

-- ------------------------------------------------------------
-- 1) TABLE "groupes_scolaires" — Entités Groupe scolaire
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.groupes_scolaires (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nom        text NOT NULL,
  code       text NOT NULL UNIQUE,
  cycles     text[] DEFAULT '{}',
  actif      boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_groupes_scolaires_code ON public.groupes_scolaires(code);

-- ------------------------------------------------------------
-- 2) Colonne "groupe_id" sur schools
-- ------------------------------------------------------------
ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS groupe_id uuid REFERENCES public.groupes_scolaires(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_schools_groupe_id ON public.schools(groupe_id);

-- ------------------------------------------------------------
-- 3) RLS sur groupes_scolaires (zéro accès anon direct)
-- ------------------------------------------------------------
ALTER TABLE public.groupes_scolaires ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "groupes_scolaires_anon_all" ON public.groupes_scolaires;
DROP POLICY IF EXISTS "groupes_scolaires_anon_read" ON public.groupes_scolaires;

-- ------------------------------------------------------------
-- 4) RPC list_active_groupes — renvoie les groupes actifs
--    pour alimenter les sélecteurs côté client.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_active_groupes()
RETURNS SETOF public.groupes_scolaires
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.groupes_scolaires WHERE actif IS NOT FALSE ORDER BY nom ASC;
$$;

GRANT EXECUTE ON FUNCTION public.list_active_groupes() TO anon;
GRANT EXECUTE ON FUNCTION public.list_active_groupes() TO authenticated;

-- ------------------------------------------------------------
-- 5) check_groupe_code — valide le code d'un Groupe scolaire
--    depuis la table groupes_scolaires (plus iefs).
--    Retourne { ok, nom, groupe_id } en cas de succès.
--    Rate limiting partagé (clé 'groupe:').
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_groupe_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key      text := 'groupe:' || md5(coalesce(p_code, ''));
  v_id       uuid;
  v_name     text;
  v_min      integer;
BEGIN
  v_min := public._rl_remaining_minutes(v_key);
  IF v_min > 0 THEN
    RETURN jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  END IF;

  SELECT id, nom INTO v_id, v_name
  FROM public.groupes_scolaires
  WHERE code = p_code AND actif IS NOT FALSE
  LIMIT 1;

  IF v_id IS NULL THEN
    PERFORM public._rl_fail(v_key);
    RETURN jsonb_build_object('ok', false);
  END IF;

  PERFORM public._rl_success(v_key);
  RETURN jsonb_build_object('ok', true, 'nom', v_name, 'groupe_id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_groupe_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_groupe_code(text) TO authenticated;

-- ------------------------------------------------------------
-- 6) Valeur par défaut : Groupe scolaire GRAND DAKAR
--    (code identique à l'ancien code IEF pour compatibilité)
-- ------------------------------------------------------------
INSERT INTO public.groupes_scolaires (nom, code, cycles, actif)
SELECT 'Groupe scolaire GRAND DAKAR', 'IEF-DAKAR', ARRAY['petite_enfance','prescolaire','elementaire','moyen','secondaire']::text[], true
WHERE NOT EXISTS (
  SELECT 1 FROM public.groupes_scolaires WHERE upper(nom) LIKE upper('%GRAND DAKAR%')
);

-- ============================================================
--  FIN DE LA MIGRATION
--  Appliquez puis rechargez la page (F5).
-- ============================================================
