-- ============================================================
--  EduLink Pro — Nettoyage des doublons dans les données des écoles
--  (déjà appliqué en production le 03/11/2026 ; idempotent)
--
--  Cause : l'ancienne fusion de conflits de version recopiait à chaque
--  conflit les listes sans identifiant (header.cycles, coTeachers, domaines
--  du barème, jours ouvrés…). Certaines écoles dépassaient 10 à 30 Mo, ce qui
--  empêchait le chargement (superviseur de groupe, IEF, Super Admin).
--  Le correctif client (mergePayloadAdditive) évite toute nouvelle duplication.
-- ============================================================
create or replace function public._dedupe_payload_json(j jsonb) returns jsonb
language plpgsql immutable set search_path to 'public' as $$
declare r jsonb;
begin
  if j is null then return null; end if;
  if jsonb_typeof(j) = 'object' then
    select coalesce(jsonb_object_agg(t.k, public._dedupe_payload_json(t.v)), '{}'::jsonb) into r from jsonb_each(j) as t(k, v);
    return r;
  elsif jsonb_typeof(j) = 'array' then
    with items as (
      select t.o, t.e,
             (jsonb_typeof(t.e) = 'string' or (jsonb_typeof(t.e) = 'object' and not (t.e ? 'id'))) as elig
      from jsonb_array_elements(j) with ordinality as t(e, o)
    ), ranked as (
      select o, e, elig, row_number() over (partition by case when elig then e end order by o) as rn from items
    )
    select coalesce(jsonb_agg(public._dedupe_payload_json(e) order by o), '[]'::jsonb) into r
    from ranked where not elig or rn = 1;
    return r;
  end if;
  return j;
end $$;
revoke all on function public._dedupe_payload_json(jsonb) from public, anon, authenticated;

-- Application ponctuelle sur une école (incrémente la version pour que les appareils ouverts resynchronisent) :
-- update school_data set payload = public._dedupe_payload_json(payload), version = coalesce(version,0)+1 where school_id = '<id>';

-- Garde-fou permanent (appliqué le 04/11/2026) : retire les doublons à chaque enregistrement quand les
-- données d'une école dépassent 300 000 caractères (protège des anciennes versions de l'application
-- encore ouvertes sur des appareils).
create or replace function public._school_data_garde_doublons() returns trigger
language plpgsql set search_path to 'public' as $$
begin
  if NEW.payload is not null and length(NEW.payload::text) > 300000 then
    NEW.payload := public._dedupe_payload_json(NEW.payload);
  end if;
  return NEW;
end $$;
drop trigger if exists trg_school_data_garde_doublons on public.school_data;
create trigger trg_school_data_garde_doublons
  before insert or update of payload on public.school_data
  for each row execute function public._school_data_garde_doublons();
revoke all on function public._school_data_garde_doublons() from public, anon, authenticated;
