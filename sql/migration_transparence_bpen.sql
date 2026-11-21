-- ============================================================
--  EduLink Pro — TRANSPARENCE RENFORCÉE — GS BPEN
--  À exécuter UNE FOIS dans Supabase → SQL Editor → Run.
--  Idempotent : peut être relancé sans doublon.
--
--  1) Table audit_logs_miroir : AJOUT SEUL, aucun accès client direct.
--  2) Trigger sur school_data : copie chaque nouvelle entrée du journal
--     d'audit dans le miroir, uniquement pour les écoles marquées
--     config.transparence_renforcee = true.
--  3) Active le flag sur les écoles « GS BPEN% » et rapporte l'existant.
--
--  Résultat : même si le payload de l'école est modifié/purgé, l'historique
--  reste intact côté serveur et n'est consultable que côté Super Admin.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Table miroir (append-only)
-- ------------------------------------------------------------
create table if not exists public.audit_logs_miroir (
  id                bigint generated always as identity primary key,
  school_id         uuid not null references public.schools(id) on delete cascade,
  entry_id          text not null,
  occurred_at_text  text,
  actor             text,
  actor_role        text,
  action            text,
  details           text,
  payload_entry     jsonb not null,
  created_at        timestamptz not null default now(),
  unique (school_id, entry_id)
);

create index if not exists idx_audit_logs_miroir_school
  on public.audit_logs_miroir(school_id, created_at desc);

alter table public.audit_logs_miroir enable row level security;

-- Aucune policy RLS volontaire : ni anon ni authenticated ne peuvent
-- lire, modifier ou supprimer le miroir. Seul le trigger (SECURITY DEFINER)
-- et le Super Admin via une RPC dédiée pourront y accéder.
revoke all on public.audit_logs_miroir from anon, authenticated, public;

-- ------------------------------------------------------------
-- 2) Fonction de recopie (déclenchée par school_data)
-- ------------------------------------------------------------
create or replace function public.mirror_audit_logs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_ids text[];
  v_entry   jsonb;
begin
  -- Uniquement les écoles en mode transparence renforcée.
  if coalesce(new.payload->'config'->>'transparence_renforcee', '') <> 'true' then
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if new.payload->'auditLog' is not distinct from old.payload->'auditLog' then
      return null;
    end if;
    select array_agg(e->>'id')
      into v_old_ids
      from jsonb_array_elements(coalesce(old.payload->'auditLog', '[]'::jsonb)) as t(e);
  else
    v_old_ids := array[]::text[];
  end if;

  for v_entry in
    select e
    from jsonb_array_elements(coalesce(new.payload->'auditLog', '[]'::jsonb)) as t(e)
  loop
    if coalesce(v_entry->>'id', '') = any(coalesce(v_old_ids, array[]::text[])) then
      continue;
    end if;

    insert into public.audit_logs_miroir
      (school_id, entry_id, occurred_at_text, actor, actor_role, action, details, payload_entry)
    values
      (new.school_id,
       coalesce(nullif(v_entry->>'id', ''), md5(v_entry::text)),
       v_entry->>'ts',
       v_entry->>'actor',
       v_entry->>'role',
       v_entry->>'action',
       v_entry->>'details',
       v_entry)
    on conflict (school_id, entry_id) do nothing;
  end loop;

  return null;
end $$;

revoke all on function public.mirror_audit_logs() from public;

drop trigger if exists trg_mirror_audit_logs on public.school_data;
create trigger trg_mirror_audit_logs
after insert or update of payload on public.school_data
for each row execute function public.mirror_audit_logs();

-- ------------------------------------------------------------
-- 3) Active le mode sur les écoles GS BPEN
-- ------------------------------------------------------------
update public.school_data sd
set payload = jsonb_set(
  coalesce(sd.payload, '{}'::jsonb),
  '{config,transparence_renforcee}',
  'true'::jsonb,
  true
)
from public.schools s
where sd.school_id = s.id
  and lower(coalesce(s.name, '')) like 'gs bpen%'
  and coalesce(sd.payload->'config'->>'transparence_renforcee', '') <> 'true';

-- 4) Rapporte les entrées déjà présentes dans le journal de GS BPEN
insert into public.audit_logs_miroir
  (school_id, entry_id, occurred_at_text, actor, actor_role, action, details, payload_entry)
select sd.school_id,
       coalesce(nullif(e->>'id', ''), md5(e::text)),
       e->>'ts',
       e->>'actor',
       e->>'role',
       e->>'action',
       e->>'details',
       e
from public.school_data sd
join public.schools s on s.id = sd.school_id
cross join lateral jsonb_array_elements(coalesce(sd.payload->'auditLog', '[]'::jsonb)) as t(e)
where lower(coalesce(s.name, '')) like 'gs bpen%'
on conflict (school_id, entry_id) do nothing;

commit;

-- Vérification (à lire après exécution)
select s.name as ecole,
       sd.payload->'config'->>'transparence_renforcee' as transparence,
       count(m.id) as entrees_miroir
from public.schools s
join public.school_data sd on sd.school_id = s.id
left join public.audit_logs_miroir m on m.school_id = s.id
where lower(coalesce(s.name, '')) like 'gs bpen%'
group by s.name, sd.payload
order by s.name;
