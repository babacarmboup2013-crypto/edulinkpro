-- ============================================================
--  SYGENOP / EduLink Pro — IEF GRAND DAKAR COMME LES AUTRES
--  À exécuter UNE FOIS dans l'éditeur SQL de Supabase.
--  Idempotent : peut être relancé sans risque.
--
--  Objectif (règles demandées) :
--   1) IEF GRAND DAKAR n'est plus une "IEF centrale" spéciale :
--      c'est une IEF ordinaire, avec une VRAIE ligne dans `iefs`
--      et ses propres codes.
--   2) Les écoles historiques sans ief_id (NULL) sont rattachées
--      à cette IEF — elles ne sont plus un cas à part.
--   3) Connexion IEF : UNIQUEMENT les codes propres à chaque IEF
--      (iefs.code_lecture ou compte admins). L'ancien code partagé
--      de ief_config ("IEF CENTRALE") n'est plus accepté → chaque
--      IEF ne voit que SA circonscription.
--   4) Connexion Super Admin : le code maître (ief_config.admin_code)
--      donne la vue GLOBALE de toutes les IEF (inchangé).
--
--  ⚠️ NB : si le code_admin de la ligne IEF GRAND DAKAR est identique
--  au code maître (ex. 'ADMIN-2025'), c'est la voie SUPER ADMIN qui
--  gagne (vue globale). Pour que Grand Dakar ait un admin STRICTEMENT
--  circonscrit, changez son code_admin depuis l'application
--  (Super Admin → Gestion des IEF → Modifier).
--
--  Ordre d'exécution recommandé : migration_multi_ief.sql,
--  migration_securite_rpc.sql, migration_securite_data.sql,
--  migration_rate_limit.sql, PUIS ce fichier.
-- ============================================================

-- ------------------------------------------------------------
-- 1) IEF GRAND DAKAR : s'assure qu'elle existe en tant que vraie IEF
--    (la migration multi_ief l'insérait déjà ; ceci reste idempotent)
-- ------------------------------------------------------------
insert into public.iefs (nom, code_lecture, code_admin, actif)
select 'IEF GRAND DAKAR', 'IEF-DAKAR', 'ADMIN-2025', true
where not exists (
  select 1 from public.iefs where upper(nom) like upper('%GRAND DAKAR%')
);

-- ------------------------------------------------------------
-- 2) Rattachement des écoles orphelines (ief_id NULL) à IEF GRAND DAKAR
--    Après cette mise à jour, toute école active appartient à une IEF
--    précise — le cas "centrale/sans IEF" disparaît des données.
-- ------------------------------------------------------------
update public.schools s
set ief_id = (
  select i.id from public.iefs i
  where upper(i.nom) like upper('%GRAND DAKAR%') and coalesce(i.actif, true) is true
  order by i.created_at asc
  limit 1
)
where s.ief_id is null;

-- ------------------------------------------------------------
-- 3) CONNEXION IEF — sans le code partagé historique.
--    Sources acceptées (dans l'ordre) :
--      a) iefs.code_lecture  → IEF précise (ief_id renvoyé)
--      b) admins.code        → compte IEF (ief_id renvoyé)
--    Le code partagé ief_config.ief_code n'est PLUS accepté :
--    fini le pseudo-rôle "IEF CENTRALE". Chaque code correspond
--    à une IEF réelle et le périmètre serveur suit cet ief_id.
--    (Rate limiting serveur conservé — cf. migration_rate_limit.sql.)
-- ------------------------------------------------------------
create or replace function public.check_ief_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key  text := 'ief:' || md5(coalesce(p_code, ''));
  v_row  public.iefs%rowtype;
  v_admin record;
  v_min  integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    return jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  end if;

  -- 1) IEF décentralisée (table iefs) — chaque code = une IEF réelle
  select * into v_row
  from public.iefs
  where code_lecture = p_code and actif is true
  limit 1;
  if found then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', v_row.nom, 'ief_id', v_row.id);
  end if;

  -- 2) Compte admins (lecture IEF)
  select id, nom, ief_id into v_admin
  from public.admins
  where code = p_code and actif is true
  limit 1;
  if found then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', v_admin.nom, 'ief_id', v_admin.ief_id);
  end if;

  perform public._rl_fail(v_key);
  return jsonb_build_object('ok', false);
end;
$$;

grant execute on function public.check_ief_code(text) to anon;
grant execute on function public.check_ief_code(text) to authenticated;

-- ------------------------------------------------------------
-- 4) CONNEXION SUPER ADMIN — INCHANGÉE fonctionnellement, mais
--    explicitée ici pour la lisibilité des règles :
--      - code maître (ief_config.admin_code) → vue GLOBALE (ief_id null)
--      - iefs.code_admin                     → admin de CETTE IEF
--      - admins.role='admin'                 → compte admin d'IEF
--    Le corps ci-dessous est identique à migration_rate_limit.sql ;
--    il est rappelé pour que ce fichier suffise à lui seul à poser
--    les règles après une restauration ou une nouvelle base.
-- ------------------------------------------------------------
create or replace function public.check_admin_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key   text := 'admin:' || md5(coalesce(p_code, ''));
  v_cfg   text;
  v_ief   public.iefs%rowtype;
  v_admin record;
  v_min   integer;
begin
  v_min := public._rl_remaining_minutes(v_key);
  if v_min > 0 then
    return jsonb_build_object('ok', false, 'locked', true, 'retry_after_min', v_min);
  end if;

  -- Code maître → Super Admin, vue globale de toutes les IEF
  select value into v_cfg
  from public.ief_config
  where key = 'admin_code';
  if v_cfg is not null and v_cfg <> '' and v_cfg = p_code then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', 'Super Admin', 'ief_id', null, 'ief_name', null);
  end if;

  -- Admin décentralisé d'une IEF précise
  select * into v_ief
  from public.iefs
  where code_admin = p_code and actif is true
  limit 1;
  if found then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', v_ief.nom, 'ief_id', v_ief.id, 'ief_name', v_ief.nom);
  end if;

  -- Compte admins (rôle admin)
  select id, nom, ief_id into v_admin
  from public.admins
  where code = p_code and actif is true and role = 'admin'
  limit 1;
  if found then
    perform public._rl_success(v_key);
    return jsonb_build_object('ok', true, 'nom', v_admin.nom, 'ief_id', v_admin.ief_id, 'ief_name', v_admin.nom);
  end if;

  perform public._rl_fail(v_key);
  return jsonb_build_object('ok', false);
end;
$$;

grant execute on function public.check_admin_code(text) to anon;
grant execute on function public.check_admin_code(text) to authenticated;

-- ============================================================
--  FIN DE LA MIGRATION
--  Résultat :
--   • IEF GRAND DAKAR = une IEF parmi les autres (ligne réelle),
--     avec toutes les anciennes écoles sans IEF rattachées chez elle.
--   • Chaque connexion IEF (lecture ou admin) est bornée à SON ief_id.
--   • Seul le code maître ouvre la vue globale Super Admin.
-- ============================================================
