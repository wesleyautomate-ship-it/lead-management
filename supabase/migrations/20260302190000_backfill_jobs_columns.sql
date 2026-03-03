-- Backfill required jobs columns for existing projects created before max_attempts/locking support.

alter table if exists public.jobs
  add column if not exists max_attempts integer not null default 10,
  add column if not exists result_json jsonb,
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'jobs_max_attempts_check'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_max_attempts_check check (max_attempts > 0);
  end if;
end
$$;
