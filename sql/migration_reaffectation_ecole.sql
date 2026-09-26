-- ============================================================
--  SYGENOP / EduLink Pro — RÉAFFECTATION SÉCURISÉE D'UNE ÉCOLE
--  À exécuter UNE FOIS dans l'éditeur SQL de Supabase.
--
--  PROBLÈME RÉSOLU
--  Le PATCH générique « schools » (via admin-write) ne modifie PAS
--  ief_id / groupe_id côté serveur : ces colonnes matérialisent la
--  frontière d'isolation entre circonscriptions (migration_ief_isolation).
--  L'interface l'acceptait pourtant (« École modifiée avec succès »)
--  alors que le vrai rattachement restait inchangé → changement perdu
--  silencieusement.
--
--  CETTE RPC est le SEUL canal de réaffectation :
--   • validée par le CODE MAÎTRE Super Admin (même vérification que
--     check_admin_code, jamais le client ne décide seul) ;
--   • met à jour schools.ief_id ET schools.groupe_id en une transaction ;
--   • synchronise l'étiquette affichée (header.ief des reçus, bulletins,
--     listes) avec le NOM de la nouvelle IEF ;
--   • incrémente la version du payload pour ne pas casser le
--     verrouillage optimiste de save_school_data.
-- ============================================================

drop function if exists public.reaffecter_ecole(uuid, uuid, uuid, text);

create or replace function public.reaffecter_ecole(
  p_school_id      uuid,
  p_nouvel_ief_id  uuid,  -- NULL = IEF GRAND DAKAR historique (écoles sans ief_id)
  p_nouveau_groupe_id uuid, -- NULL = aucun groupe scolaire
  p_admin_code     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg          text;
  v_school_id    uuid;
  v_new_ief_nom  text;
  v_payload      jsonb;
  v_version      integer;
begin
  -- 1) Seul le code maître (Super Admin global, vue globale) peut réaffecter.
  select value into v_cfg
  from public.ief_config
  where key = 'admin_code';
  if v_cfg is null or v_cfg = '' or v_cfg <> coalesce(p_admin_code, '') then
    return jsonb_build_object('ok', false, 'error', 'Accès refusé : code Super Admin requis');
  end if;

  -- 2) L'école doit exister.
  select id into v_school_id from public.schools where id = p_school_id;
  if v_school_id is null then
    return jsonb_build_object('ok', false, 'error', 'École introuvable');
  end if;

  -- 3) Résout le nom d'affichage de la destination.
  if p_nouvel_ief_id is null then
    v_new_ief_nom := 'IEF GRAND DAKAR';
  else
    select nom into v_new_ief_nom from public.iefs where id = p_nouvel_ief_id;
    if v_new_ief_nom is null then
      return jsonb_build_object('ok', false, 'error', 'IEF de destination introuvable');
    end if;
  end if;

  -- 4) Réaffecte (transaction).
  update public.schools
     set ief_id    = p_nouvel_ief_id,
         groupe_id = p_nouveau_groupe_id
   where id = p_school_id;

  -- 5) Synchronise l'étiquette du payload + version (verrouillage optimiste).
  select payload, version into v_payload, v_version
  from public.school_data
  where school_id = p_school_id
  limit 1;
  if v_payload is not null then
    update public.school_data
       set payload = jsonb_set(v_payload, '{header,ief}', to_jsonb(v_new_ief_nom)),
           version = coalesce(v_version, 0) + 1
     where school_id = p_school_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'ief_id', p_nouvel_ief_id,
    'groupe_id', p_nouveau_groupe_id,
    'ief_nom', v_new_ief_nom
  );
end;
$$;

grant execute on function public.reaffecter_ecole(uuid, uuid, uuid, text) to anon;
grant execute on function public.reaffecter_ecole(uuid, uuid, uuid, text) to authenticated;

-- ============================================================
--  FIN DE LA MIGRATION
-- ============================================================