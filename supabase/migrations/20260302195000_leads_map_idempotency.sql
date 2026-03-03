-- Ensure leads_map supports pf_event_id idempotency and lookups.

alter table if exists public.leads_map
  add column if not exists pf_event_id text,
  add column if not exists pf_reference text,
  add column if not exists zoho_lead_id text,
  add column if not exists status text default 'received',
  add column if not exists raw_json jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists leads_map_pf_event_id_uidx
  on public.leads_map (pf_event_id)
  where pf_event_id is not null;

create index if not exists leads_map_pf_reference_idx
  on public.leads_map (pf_reference)
  where pf_reference is not null;

create index if not exists leads_map_zoho_lead_id_idx
  on public.leads_map (zoho_lead_id)
  where zoho_lead_id is not null;
