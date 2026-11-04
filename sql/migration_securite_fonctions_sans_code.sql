-- EduLink Pro — fermeture des lectures sans code d'accès (appliqué en production le 04/11/2026)
-- 1) Edge Function read-schools : remplacée par une réponse 410 « fonction retirée » (verify_jwt activé).
--    La lecture passe uniquement par read-schools-secure (code vérifié côté serveur).
-- 2) Fonctions jamais utilisées par l'application et ouvertes à tous : accès retiré.
revoke execute on function public.get_school_personnel(uuid) from public, anon, authenticated;
revoke execute on function public.get_schools_overview(uuid, boolean) from public, anon, authenticated;
-- 3) search_school_personnel (connexion du personnel, avant saisie du code) : 3 caractères minimum,
--    5 résultats maximum, personnel avec accès et code défini uniquement, champs id/prénom/nom/rôle seulement.
--    (Définition complète : voir la migration « securite_fonctions_sans_code » de Supabase.)
