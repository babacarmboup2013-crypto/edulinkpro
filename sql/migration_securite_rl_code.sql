-- EduLink Pro — durcissement (appliqué en production le 2026-10-28)
-- 1) Fonctions internes du verrouillage de connexion : non appelables via l'API publique
--    (sinon _rl_success pouvait remettre à zéro le compteur d'essais et contourner la protection).
revoke execute on function public._rl_fail(text) from public, anon, authenticated;
revoke execute on function public._rl_is_locked(text) from public, anon, authenticated;
revoke execute on function public._rl_lock(text, integer) from public, anon, authenticated;
revoke execute on function public._rl_remaining_minutes(text) from public, anon, authenticated;
revoke execute on function public._rl_success(text) from public, anon, authenticated;
revoke execute on function public._gen_groupe_school_code() from public, anon, authenticated;

-- 2) La colonne schools.code (code d'accès) n'est plus lisible avec la clé publique.
revoke select on public.schools from anon, authenticated;
grant select (id, name, type, created_at, ief_id, directeur, actif, cycle, cycles, groupe_id)
  on public.schools to anon, authenticated;

-- 3) Vue public_schools (SECURITY DEFINER, inutilisée) supprimée.
drop view if exists public.public_schools;

-- Retour arrière du point 2 si besoin : grant select on public.schools to anon, authenticated;
