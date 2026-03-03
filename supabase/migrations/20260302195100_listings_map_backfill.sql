-- Ensure listings_map has columns needed for owner resolution cache.

alter table if exists public.listings_map
  add column if not exists pf_reference text,
  add column if not exists pf_listing_id text,
  add column if not exists zoho_listing_id text,
  add column if not exists zoho_owner_user_id text,
  add column if not exists zoho_owner_name text,
  add column if not exists status text default 'unknown',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists listings_map_pf_reference_uidx
  on public.listings_map (pf_reference)
  where pf_reference is not null;

create index if not exists listings_map_zoho_owner_user_id_idx
  on public.listings_map (zoho_owner_user_id)
  where zoho_owner_user_id is not null;
