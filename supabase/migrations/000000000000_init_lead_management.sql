-- 000000000000_init_lead_management.sql
-- Initial schema for lead-management middleware

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  status text not null check (status in ('queued', 'processing', 'success', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 10 check (max_attempts > 0),
  run_after timestamptz not null default timezone('utc', now()),
  payload_json jsonb not null default '{}'::jsonb,
  result_json jsonb,
  last_error text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists jobs_status_run_after_idx
  on public.jobs (status, run_after);

create index if not exists jobs_type_status_idx
  on public.jobs (type, status);

create index if not exists jobs_created_at_idx
  on public.jobs (created_at desc);

create table if not exists public.listings_map (
  pf_reference text primary key,
  pf_listing_id text,
  zoho_listing_id text not null,
  zoho_owner_user_id text not null,
  zoho_owner_name text,
  status text default 'unknown',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists listings_map_zoho_listing_id_idx
  on public.listings_map (zoho_listing_id);

create table if not exists public.leads_map (
  pf_lead_id text primary key,
  pf_event_id text,
  pf_reference text references public.listings_map(pf_reference) on delete set null,
  zoho_lead_id text,
  status text default 'received',
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'leads_map'
      and column_name = 'zoho_lead_id'
  ) then
    execute 'create index if not exists leads_map_zoho_lead_id_idx on public.leads_map (zoho_lead_id)';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'leads_map'
      and column_name = 'pf_reference'
  ) then
    execute 'create index if not exists leads_map_pf_reference_idx on public.leads_map (pf_reference)';
  end if;
end
$$;

create trigger set_jobs_updated_at
before update on public.jobs
for each row
execute function public.set_updated_at();

create trigger set_listings_map_updated_at
before update on public.listings_map
for each row
execute function public.set_updated_at();

create trigger set_leads_map_updated_at
before update on public.leads_map
for each row
execute function public.set_updated_at();
