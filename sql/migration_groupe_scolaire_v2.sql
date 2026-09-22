-- ============================================================
--  EduLink Pro — GROUPE SCOLAIRE : ENTITÉ AVEC CYCLES
--  À exécuter dans l'éditeur SQL de Supabase (après
--  migration_multi_ief.sql et migration_rate_limit.sql).
--  Idempotent.
--
--  Changements :
--   1) Colonne `cycles` sur `iefs` — stocke les cycles cochés
--      lors de la création d'un Groupe scolaire.
--   2) check_groupe_code — valide maintenant le code du Groupe
--      scolaire (iefs.code_lecture) au lieu du code d'une école.
--      Retourne { ok, nom, ief_id } pour la session côté client.
-- ============================================================

-- ------------------------------------------------------------
-- 1) COLONNE CYCLES SUR IEF
--    Les groupes scolaires cochent leurs cycles à la création.
-- ------------------------------------------------------------
ALTER TABLE public.iefs ADD COLUMN IF NOT EXISTS cycles text[] DEFAULT '{}';

-- ------------------------------------------------------------
-- 2) CHECK_GROUPE_CODE — VALIDATION DU CODE GROUPE SCOLAIRE
--    Anciennement : validait le code d'une école (2-5 cycles).
--    Maintenant : valide le code_lecture du Groupe scolaire (iefs).
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
