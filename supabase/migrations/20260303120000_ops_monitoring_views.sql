-- Operational monitoring views for jobs queue health and alerting.

create or replace view public.v_jobs_status_counts as
select
  status,
  count(*)::bigint as jobs_count,
  min(run_after) as oldest_run_after,
  max(updated_at) as latest_updated_at
from public.jobs
group by status;

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
where status = 'failed'
   or (status = 'queued' and attempts > 0)
order by updated_at desc;

create or replace view public.v_jobs_error_top_24h as
select
  coalesce(nullif(split_part(last_error, ':', 1), ''), 'unknown') as error_code,
  count(*)::bigint as occurrences,
  max(updated_at) as last_seen_at
from public.jobs
where last_error is not null
  and updated_at >= timezone('utc', now()) - interval '24 hours'
group by 1
order by occurrences desc, last_seen_at desc;

create or replace view public.v_jobs_stuck_processing as
select
  id,
  type,
  status,
  attempts,
  max_attempts,
  locked_at,
  locked_by,
  created_at,
  updated_at,
  timezone('utc', now()) - locked_at as processing_age
from public.jobs
where status = 'processing'
  and locked_at is not null
  and locked_at < timezone('utc', now()) - interval '10 minutes'
order by locked_at asc;
