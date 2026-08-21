-- Keep the public intake bootstrap readable while ensuring every private
-- scheduling entity is reachable only through teacher RLS or the intake Edge
-- Function's short-lived student session.
revoke all privileges on table
  public.sched_class_members,
  public.sched_classes,
  public.sched_intake_submissions,
  public.sched_optimizer_settings,
  public.sched_schedule_runs,
  public.sched_sessions,
  public.sched_students,
  public.sched_teacher_availability,
  public.sched_travel_times
from anon;

revoke insert, update, delete, truncate, references, trigger
  on table public.sched_locations, public.sched_student_form_config
  from anon;

grant usage on schema public to anon;
grant select on table public.sched_locations, public.sched_student_form_config to anon;
