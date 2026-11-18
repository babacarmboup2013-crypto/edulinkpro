-- ============================================================
--  EduLink Pro — RÉPARATION « SMERA » : transformer l'ancienne fiche
--  multi-cycles en un VRAI GROUPE SCOLAIRE (une école membre par cycle).
--
--  À exécuter UNE FOIS dans Supabase → SQL Editor → Run.
--  Idempotent : peut être relancé sans rien casser ni dupliquer.
--
--  Résultat :
--    • un groupe scolaire SMERA (avec son code de connexion) ;
--    • l'ancienne fiche Smera rattachée à ce groupe et limitée à un cycle ;
--    • une école membre supplémentaire par cycle déclaré ;
--    • un payload school_data vide initialisé pour chaque nouvelle école
--      (les données du cycle principal restent intactes).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0) Mémorise l'état d'ORIGINE des fiches Smera (avant normalisation)
-- ------------------------------------------------------------
create temp table smera_src on commit drop as
select id, name, type, directeur, code, actif, ief_id, groupe_id, cycle, cycles
from public.schools
where lower(coalesce(name, '')) like '%smera%';

do $$
begin
  if not exists (select 1 from smera_src) then
    raise exception 'Aucune école dont le nom contient « smera » n''a été trouvée dans public.schools.';
  end if;
end $$;

create temp table smera_created(id uuid) on commit drop;

-- ------------------------------------------------------------
-- 1) Groupe cible (créé s'il n'existe pas encore)
-- ------------------------------------------------------------
do $$
declare v_id uuid;
begin
  select id into v_id
  from public.groupes_scolaires
  where lower(nom) like '%smera%'
  order by created_at
  limit 1;

  if v_id is null then
    insert into public.groupes_scolaires (nom, code, cycles, actif)
    values ('GS SMERA SCHOOL', 'SMERA-G', array['elementaire', 'moyen']::text[], true)
    returning id into v_id;
  end if;

  create temp table smera_ctx on commit drop as
  select v_id as groupe_id,
         (select code from public.groupes_scolaires where id = v_id) as code_groupe;
end $$;

-- ------------------------------------------------------------
-- 2) Rattache les fiches Smera au groupe + un seul cycle par fiche
--    (le cycle principal est conservé, ses données ne bougent pas)
-- ------------------------------------------------------------
update public.schools s
set groupe_id = ctx.groupe_id,
    cycle = coalesce(nullif(s.cycle, ''), src.cycles[1], 'elementaire'),
    cycles = array[coalesce(nullif(s.cycle, ''), src.cycles[1], 'elementaire')]::text[],
    actif = true
from smera_ctx ctx, smera_src src
where s.id = src.id
  and (s.groupe_id is distinct from ctx.groupe_id
       or s.actif is not true
       or coalesce(array_length(s.cycles, 1), 0) <> 1);

create temp table smera_primary on commit drop as
select coalesce(nullif(cycle, ''), cycles[1], 'elementaire') as cycle
from smera_src
order by id
limit 1;

-- ------------------------------------------------------------
-- 3) Cycles supplémentaires → une école membre par cycle
--    (on lit les cycles D'ORIGINE + ceux déclarés sur le groupe)
-- ------------------------------------------------------------
create temp table smera_extra on commit drop as
select distinct u.cycle
from (
  select unnest(coalesce(src.cycles, '{}'::text[])) as cycle from smera_src src
  union
  select unnest(coalesce(g.cycles, '{}'::text[])) as cycle
  from public.groupes_scolaires g, smera_ctx ctx
  where g.id = ctx.groupe_id
) u
where u.cycle is not null
  and u.cycle in ('petite_enfance', 'prescolaire', 'elementaire', 'moyen', 'secondaire')
  and u.cycle <> (select cycle from smera_primary)
  and not exists (
    select 1
    from public.schools s2, smera_ctx ctx2
    where s2.groupe_id = ctx2.groupe_id
      and coalesce(s2.cycle, s2.cycles[1]) = u.cycle
      and lower(coalesce(s2.name, '')) like '%smera%'
  );

-- ------------------------------------------------------------
-- 4) Crée les écoles membres manquantes
-- ------------------------------------------------------------
with ins as (
  insert into public.schools
    (name, type, cycle, cycles, directeur, code, actif, ief_id, groupe_id)
  select base.name,
         case lower(coalesce(base.type, ''))
           when 'publique' then 'publique'
           when 'ecole publique' then 'publique'
           when 'privee' then 'privee'
           when 'ecole privee' then 'privee'
           when 'daara moderne' then 'daara_moderne'
           when 'petite enfance' then 'petite_enfance'
           else coalesce(nullif(base.type, ''), 'publique')
         end,
         x.cycle,
         array[x.cycle]::text[],
         coalesce(base.directeur, ''),
         upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
         true,
         base.ief_id,
         ctx.groupe_id
  from (select * from smera_src order by id limit 1) base
  cross join smera_extra x
  cross join smera_ctx ctx
  returning id
)
insert into smera_created(id)
select id from ins;

-- ------------------------------------------------------------
-- 5) Initialise un payload vide pour chaque nouvelle école
-- ------------------------------------------------------------
insert into public.school_data (school_id, payload, version)
select n.id,
       jsonb_build_object(
         'header', jsonb_build_object(
           'ia', 'DAKAR',
           'ief', coalesce(
             case when to_regclass('public.iefs') is not null
                  then (select nom from public.iefs where id = n.ief_id) end,
             'GRAND DAKAR'
           ),
           'ecole', n.name,
           'type', case n.type
                     when 'publique' then 'École Publique'
                     when 'privee' then 'École Privée'
                     when 'daara_moderne' then 'Daara Moderne'
                     when 'petite_enfance' then 'Petite Enfance'
                     else coalesce(n.type, 'École Publique')
                   end,
           'directeur', coalesce(n.directeur, ''),
           'tel', '',
           'annee', '2026/2027',
           'periodeActif', 'T1',
           'cycle', n.cycle,
           'cycles', n.cycles
         ),
         'config', '{}'::jsonb,
         'classes', '{}'::jsonb,
         'personnel', '[]'::jsonb,
         'studentTransferRequests', '[]'::jsonb,
         'staffAbsenceRequests', '[]'::jsonb,
         'staffAttestRequests', '[]'::jsonb,
         'staffCertCounter', 0,
         'pointage', '{}'::jsonb,
         'fees', '{}'::jsonb,
         'recuSeq', 0,
         'mohebs', false,
         'category', 'public',
         'depenses', '[]'::jsonb,
         'auditLog', '[]'::jsonb,
         'actualites', '[]'::jsonb
       ),
       1
from public.schools n
join smera_created c on c.id = n.id
where not exists (select 1 from public.school_data sd where sd.school_id = n.id);

-- ------------------------------------------------------------
-- 6) Synchronise la liste des cycles du groupe avec ses membres
-- ------------------------------------------------------------
update public.groupes_scolaires g
set cycles = array(
  select distinct coalesce(s.cycle, s.cycles[1])
  from public.schools s
  where s.groupe_id = g.id
  order by 1
)
where g.id = (select groupe_id from smera_ctx);

-- ------------------------------------------------------------
-- 7) Compte-rendu affiché dans Supabase
-- ------------------------------------------------------------
do $$
declare v_groupe_id uuid;
        v_code      text;
        v_nb        integer;
begin
  select groupe_id, code_groupe into v_groupe_id, v_code from smera_ctx;
  select count(*) into v_nb from public.schools where groupe_id = v_groupe_id;

  raise notice '✅ Groupe SMERA : %', v_groupe_id;
  raise notice '✅ Code de connexion du groupe : %', v_code;
  raise notice '✅ Écoles membres rattachées : %', v_nb;
end $$;

commit;

-- Vérification finale (à lire après exécution)
select g.nom, g.code, g.cycles,
       s.name, s.code as code_ecole, s.cycle, s.actif,
       coalesce(jsonb_object_length(sd.payload->'classes'), 0) as nb_classes
from public.groupes_scolaires g
join public.schools s on s.groupe_id = g.id
left join public.school_data sd on sd.school_id = s.id
where lower(g.nom) like '%smera%'
order by s.cycle, s.name;
