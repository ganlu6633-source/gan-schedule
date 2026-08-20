-- Student intake is anonymous. Only active location options are intentionally public.
grant usage on schema public to anon;
grant select on table public.sched_locations to anon;

drop policy if exists sched_locations_public_read_active on public.sched_locations;
create policy sched_locations_public_read_active
on public.sched_locations
for select
to anon
using (active = true);
