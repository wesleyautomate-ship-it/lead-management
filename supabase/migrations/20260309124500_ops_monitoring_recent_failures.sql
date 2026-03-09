-- Keep alerts focused on active incidents instead of historical failed jobs.

create or replace view public.v_jobs_retry_or_failed as
select
  id,
  type,
  status,
  attempts,
  max_attempts,
  run_after,
  last_error,
  result_json,
  created_at,
  updated_at
from public.jobs
where (status = 'failed' and updated_at >= timezone('utc', now()) - interval '24 hours')
   or (status = 'queued' and attempts > 0)
order by updated_at desc;

grant select on public.v_jobs_status_counts to anon, authenticated, service_role;
grant select on public.v_jobs_retry_or_failed to anon, authenticated, service_role;
grant select on public.v_jobs_error_top_24h to anon, authenticated, service_role;
grant select on public.v_jobs_stuck_processing to anon, authenticated, service_role;
