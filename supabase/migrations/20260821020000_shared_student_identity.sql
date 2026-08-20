alter table public.sched_intake_submissions
  add column if not exists chem_student_id uuid
  references public.chem_students_v2(id) on delete set null;

create index if not exists sched_intake_submissions_chem_student_id_idx
  on public.sched_intake_submissions(chem_student_id, created_at desc);

comment on column public.sched_intake_submissions.chem_student_id is
  'Shared identity from the chemistry review system. Student login codes are never stored here.';

-- Keep the weekend commute matrix complete for every active teaching-location
-- pair. Values are conservative road-time estimates plus a separate 10-minute
-- handoff buffer; teachers can adjust them later in Location Management.
insert into public.sched_travel_times (
  id,
  from_location_id,
  to_location_id,
  minutes,
  buffer_minutes,
  created_at,
  updated_at
)
select
  gen_random_uuid(),
  from_location.id,
  to_location.id,
  case
    when (
      from_location.name like '%江南水都%'
      and to_location.name like '%光明港%'
    ) or (
      from_location.name like '%光明港%'
      and to_location.name like '%江南水都%'
    ) then 30
    when (
      from_location.name like '%江南水都%'
      and to_location.name like '%观风亭%'
    ) or (
      from_location.name like '%观风亭%'
      and to_location.name like '%江南水都%'
    ) then 25
    else 20
  end,
  10,
  now(),
  now()
from public.sched_locations as from_location
cross join public.sched_locations as to_location
where from_location.active
  and to_location.active
  and from_location.id <> to_location.id
on conflict (from_location_id, to_location_id)
do update set
  minutes = excluded.minutes,
  buffer_minutes = excluded.buffer_minutes,
  updated_at = now();

-- Anonymous clients must not bypass the shared chemistry identity check.
-- Student writes now go through chemistry-schedule-access using a validated,
-- short-lived app session; the service-role client performs the actual insert.
drop policy if exists sched_intake_anon_insert
  on public.sched_intake_submissions;

revoke insert on table public.sched_intake_submissions from anon;

comment on table public.sched_intake_submissions is
  'Student intake is written only by the authenticated shared-identity Edge Function or an allowlisted teacher.';
