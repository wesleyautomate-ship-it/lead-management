# Lead Management Middleware Documentation

Last updated: 2026-03-03

## 1) Purpose

This project is a Supabase-based middleware that receives Property Finder lead webhooks, queues jobs, resolves listing ownership in Zoho CRM, creates Zoho leads assigned to the right owner, and stores idempotency mappings to avoid duplicates.

Primary flow:

1. Property Finder sends lead webhook
2. `pf-webhook` stores job in `public.jobs`
3. `jobs-worker` picks queued jobs
4. Worker resolves owner from `public.listings_map` or Zoho Products
5. Worker creates Zoho lead in Leads module
6. Worker writes `public.leads_map` idempotency mapping
7. Worker updates `jobs.result_json` with outcome

## 2) Current Repository Structure

```text
lead-management/
  README.md
  .env.local
  supabase/
    config.toml
    migrations/
      000000000000_init_lead_management.sql
      20260302190000_backfill_jobs_columns.sql
      20260302195000_leads_map_idempotency.sql
      20260302195100_listings_map_backfill.sql
    functions/
      pf-webhook/index.ts
      jobs-worker/index.ts
```

## 3) Data Model

### 3.1 `public.jobs`

Queue table used for async processing.

Important columns:

- `id uuid primary key`
- `type text` (currently `pf_lead_received`)
- `status text` (`queued`, `processing`, `success`, `failed`)
- `attempts integer`
- `max_attempts integer`
- `run_after timestamptz`
- `payload_json jsonb`
- `result_json jsonb`
- `last_error text`
- `locked_at timestamptz`
- `locked_by text`
- `created_at`, `updated_at`

Indexes:

- `jobs_status_run_after_idx`
- `jobs_type_status_idx`
- `jobs_created_at_idx`

### 3.2 `public.listings_map`

Cache for listing-to-owner mapping.

Current structure:

- `pf_reference text` (primary key)
- `pf_listing_id text`
- `zoho_listing_id text not null`
- `zoho_owner_user_id text not null`
- `zoho_owner_name text`
- `status text default 'unknown'`
- `created_at`, `updated_at`

Indexes:

- `listings_map_zoho_listing_id_idx`
- `listings_map_pf_reference_uidx`
- `listings_map_zoho_owner_user_id_idx`

### 3.3 `public.leads_map`

Idempotency and external ID mapping.

Current worker uses:

- `pf_event_id`
- `pf_reference`
- `zoho_lead_id`

Schema also includes historical columns from initial migration:

- `pf_lead_id` (legacy primary key)
- `status`
- `raw_json`
- timestamps

Indexes:

- `leads_map_pf_event_id_uidx` (idempotency)
- `leads_map_pf_reference_idx`
- `leads_map_zoho_lead_id_idx`

## 4) Edge Functions

### 4.1 `pf-webhook`

Behavior:

1. Accepts `POST` only
2. Parses JSON payload
3. Detects event id in this order:
   - `eventId`
   - `event_id`
   - `id`
   - generated UUID fallback
4. Inserts job:
   - `type = 'pf_lead_received'`
   - `status = 'queued'`
   - `payload_json = { eventId, raw }`
5. Returns `{ ok: true }` on success

Current test mode:

- Deployed with `--no-verify-jwt`
- Tests intentionally call without `Authorization` header

### 4.2 `jobs-worker`

Behavior summary:

1. Accepts `POST` only
2. Loads queued jobs (`status='queued'` and `run_after <= now`)
3. Claims each job atomically (`status='processing'`)
4. Processes supported type `pf_lead_received`
5. On success:
   - updates `jobs.status='success'`
   - writes rich `result_json`
6. On failure:
   - sets `jobs.status='queued'`
   - increments `attempts`
   - sets `run_after = now + 5 minutes`
   - writes `last_error`
   - sets `result_json = { action: 'failed' }`

Zoho-specific behavior:

- Uses refresh-token OAuth (`accounts.zoho.com/oauth/v2/token`)
- Caches access token in-memory with expiry buffer
- Resolves owner in this order:
  1. `listings_map` by `pf_reference`
  2. Zoho module search by PF reference field
  3. COQL fallback if field is not searchable
  4. `ZOHO_FALLBACK_OWNER_USER_ID` fallback owner
- Creates Zoho lead with:
  - mandatory `Last_Name`
  - `Owner.id`
  - PF reference/responseLink/channel mapped by env field names
- Checks `leads_map` by `pf_event_id` before creation (idempotency)
- Inserts mapping into `leads_map` after successful lead creation

## 5) Environment Variables

Keep secrets in `.env.local` locally and push relevant values to Supabase Function Secrets.

### 5.1 Supabase / PF

- `SUPABASE_PROJECT_REF`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ACCESS_TOKEN`
- `PF_API_KEY`
- `PF_API_SECRET`
- `PF_WEBHOOK_SECRET`

### 5.2 Zoho

- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_API_DOMAIN` (US: `https://www.zohoapis.com`)
- `ZOHO_FALLBACK_OWNER_USER_ID`
- `ZOHO_LISTINGS_MODULE_API_NAME` (currently `Products`)
- `ZOHO_LEADS_MODULE_API_NAME` (currently `Leads`)
- `ZOHO_LISTING_PF_REFERENCE_FIELD_API_NAME` (currently `PF_Reference`)
- `ZOHO_LEAD_PF_REFERENCE_FIELD_API_NAME` (currently `PF_Reference`)
- `ZOHO_LEAD_PF_RESPONSE_LINK_FIELD_API_NAME` (example `PF_Response_Link`)
- `ZOHO_LEAD_PF_CHANNEL_FIELD_API_NAME` (example `PF_Channel`)

Important:

- `supabase secrets set --env-file .env.local` skips vars starting with `SUPABASE_` by design.
- That warning is expected.

## 6) Windows Setup and Deployment Runbook

All commands below are PowerShell.

### 6.1 Install Supabase CLI (Scoop)

```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
irm get.scoop.sh | iex
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
supabase --version
```

### 6.2 Load `.env.local` into session

```powershell
Get-Content .env.local | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#')) {
    $name, $value = $line -split '=', 2
    Set-Item -Path "Env:$name" -Value $value
  }
}
```

### 6.3 Link project and push schema

```powershell
supabase login
supabase init
supabase link --project-ref $env:SUPABASE_PROJECT_REF
supabase db push
```

### 6.4 Set function secrets and deploy

```powershell
supabase secrets set --env-file .env.local
supabase functions deploy pf-webhook --no-verify-jwt
supabase functions deploy jobs-worker --no-verify-jwt
```

Note:

- `WARNING: Docker is not running` can appear during deploy but deployment can still succeed.

## 7) Zoho Configuration Guide

### 7.1 Module API Name

In Zoho CRM:

1. `Settings`
2. `Modules and Fields`
3. Select module
4. Open `Summary`
5. Read `API Name`

Example:

- Display name: Listings
- Module API name can still be: `Products`

Use API name, not display name.

### 7.2 Field API Name

In module `Fields`:

1. Open target field
2. Read API name from field details

Example:

- Label: `PF Reference`
- API Name: `PF_Reference`

### 7.3 Refresh Token and Scopes

Required scopes for this worker:

- `ZohoCRM.modules.ALL`
- `ZohoCRM.coql.READ`

For new consent flow ensure:

- `access_type=offline`
- `prompt=consent`

Then exchange auth code:

```powershell
$code = "<CODE_FROM_CALLBACK_URL>"
Invoke-RestMethod -Method POST `
  -Uri "https://accounts.zoho.com/oauth/v2/token" `
  -ContentType "application/x-www-form-urlencoded" `
  -Body "grant_type=authorization_code&client_id=$($env:ZOHO_CLIENT_ID)&client_secret=$($env:ZOHO_CLIENT_SECRET)&redirect_uri=http://localhost:3000/callback&code=$code"
```

Store returned `refresh_token` in `.env.local`.

## 8) End-to-End Test (No Authorization Header)

Prerequisites:

1. A real PF reference exists in Zoho Products field `PF_Reference`
2. Functions deployed with `--no-verify-jwt`
3. Secrets pushed

### 8.1 Trigger webhook and worker

```powershell
$projectRef = $env:SUPABASE_PROJECT_REF
$pfWebhookUrl = "https://$projectRef.functions.supabase.co/pf-webhook"
$workerUrl = "https://$projectRef.functions.supabase.co/jobs-worker"
$eventId = "evt-test-$([Guid]::NewGuid().ToString('N').Substring(0,12))"

$body = @"
{
  "id": "$eventId",
  "type": "lead.created",
  "timestamp": "2026-03-01T12:00:00Z",
  "entity": { "id": "lead-test-001", "type": "lead" },
  "payload": {
    "channel": "call",
    "status": "sent",
    "entityType": "listing",
    "listing": { "id": "pf-listing-001", "reference": "PF-REAL-REFERENCE" },
    "responseLink": "https://example.com/respond",
    "sender": {
      "name": "Test Lead",
      "contacts": [
        { "type": "phone", "value": "+971500000000" },
        { "type": "email", "value": "test@example.com" }
      ]
    }
  }
}
"@

Invoke-RestMethod -Method POST `
  -Uri $pfWebhookUrl `
  -Headers @{ "Content-Type" = "application/json" } `
  -Body $body

Invoke-RestMethod -Method POST `
  -Uri $workerUrl `
  -Headers @{ "Content-Type" = "application/json" } `
  -Body '{}'
```

### 8.2 Verify result via REST API

Use project-ref based URL for REST:

```powershell
$restBase = "https://$($env:SUPABASE_PROJECT_REF).supabase.co"
$headers = @{
  apikey = $env:SUPABASE_SERVICE_ROLE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
}

Invoke-RestMethod -Method GET `
  -Uri "$restBase/rest/v1/jobs?select=id,type,status,attempts,last_error,result_json,created_at&type=eq.pf_lead_received&order=created_at.desc&limit=5" `
  -Headers $headers

Invoke-RestMethod -Method GET `
  -Uri "$restBase/rest/v1/leads_map?select=pf_event_id,pf_reference,zoho_lead_id,created_at&order=created_at.desc&limit=5" `
  -Headers $headers
```

Success criteria:

- latest `jobs.result_json.action = "created"`
- `jobs.status = "success"`
- a `leads_map` row exists with matching `pf_event_id`

## 9) Validation Queries (Dashboard SQL Editor)

If your Supabase CLI version lacks `supabase db query`, run these in Dashboard SQL Editor.

### 9.1 Confirm tables

```sql
select table_name
from information_schema.tables
where table_schema='public'
order by table_name;
```

Expected to include:

- `jobs`
- `listings_map`
- `leads_map`

### 9.2 Check recent jobs

```sql
select id, type, status, attempts, last_error, result_json, created_at
from public.jobs
order by created_at desc
limit 20;
```

### 9.3 Check lead mappings

```sql
select pf_event_id, pf_reference, zoho_lead_id, created_at
from public.leads_map
order by created_at desc
limit 20;
```

## 10) Known Issues and Troubleshooting

### 10.1 `zoho_auth_failed:400` with `Access Denied` / too many requests

Cause:

- Zoho token endpoint throttling due frequent refresh calls.

Action:

1. Wait and retry
2. Re-test with fewer repeated calls
3. Keep token caching enabled in worker (already implemented)

### 10.2 `INVALID_URL_PATTERN` from Zoho

Cause:

- malformed URL (often from bad PowerShell string interpolation).

Action:

- Build URLs with explicit variable boundaries:
  - `"$zohoBase/crm/v4/$($moduleName)?fields=id,$($pfField),Owner..."`

### 10.3 `field is not available for search`

Cause:

- Zoho field is not searchable in standard search API.

Action:

- Worker already falls back to COQL query.
- Ensure token has `ZohoCRM.coql.READ`.

### 10.4 `leads_map_insert_failed` about `pf_lead_id`

Cause:

- Worker inserting columns not present in runtime schema variant.

Action:

- Fixed in worker by inserting only:
  - `pf_event_id`
  - `pf_reference`
  - `zoho_lead_id`

### 10.5 Supabase secrets warnings for `SUPABASE_*`

Cause:

- CLI disallows setting reserved names.

Action:

- Ignore warnings; expected behavior.

## 11) Operations Runbook

### 11.1 Manual worker trigger

```powershell
$workerUrl = "https://$($env:SUPABASE_PROJECT_REF).functions.supabase.co/jobs-worker"
Invoke-RestMethod -Method POST -Uri $workerUrl -Headers @{ "Content-Type" = "application/json" } -Body '{}'
```

### 11.2 Requeue policy

Current policy:

- On failure, retry in 5 minutes.
- `attempts` increments on every failure.
- Worker currently requeues without hard-stop on `max_attempts` (future hardening recommended).

### 11.3 Monitoring focus

Track:

- `jobs.status`
- `jobs.attempts`
- `jobs.last_error`
- `jobs.result_json.action`

## 12) Security Hardening Backlog

Current stage is test-first and open webhook access (`--no-verify-jwt`).

Next hardening steps:

1. Validate Property Finder signature/HMAC using `PF_WEBHOOK_SECRET`
2. Add replay protection (timestamp + nonce/event id window)
3. Restrict worker trigger (JWT verify or internal scheduler only)
4. Add least-privilege secret handling and rotation policy
5. Add alerting on repeated failures

## 13) Automated jobs-worker Scheduler

### 13.1 Capability detection result

From this repository and current Supabase CLI:

- No native scheduling command is available under `supabase functions`.
- No repo-level Supabase Scheduled Function config exists.

Implemented scheduler:

- GitHub Actions fallback in `.github/workflows/jobs-worker-cron.yml`

### 13.2 How the scheduler works

- Workflow schedule: every 5 minutes (GitHub minimum)
- Inside each run: it triggers `jobs-worker` every 60 seconds for 5 iterations
- Trigger call includes:
  - `Content-Type: application/json`
  - `X-Cron-Secret: <WORKER_CRON_SECRET>`

### 13.3 Required GitHub repository secrets

1. `SUPABASE_PROJECT_REF`
2. `WORKER_CRON_SECRET`

GitHub path:

- `Settings` -> `Secrets and variables` -> `Actions`

### 13.4 Current trigger protection behavior

`jobs-worker` now supports header `x-cron-secret`:

- Valid header secret: allowed
- Invalid header secret: `401 invalid_cron_secret`
- Missing header: allowed (test mode), warning logged

This is intentionally permissive for current testing stage.

### 13.5 Verify scheduler works without manual worker call

Checklist:

1. Trigger `pf-webhook` once (do not call `jobs-worker` manually)
2. Wait 60-90 seconds
3. Query jobs and leads_map
4. Confirm latest target row has:
   - `jobs.status = 'success'`
   - `jobs.result_json.action = 'created'`
   - matching `leads_map.pf_event_id`

Exact verification queries:

```powershell
$restBase = "https://$($env:SUPABASE_PROJECT_REF).supabase.co"
$headers = @{
  apikey = $env:SUPABASE_SERVICE_ROLE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
}

Invoke-RestMethod -Method GET `
  -Uri "$restBase/rest/v1/jobs?select=id,type,status,attempts,last_error,result_json,created_at&type=eq.pf_lead_received&order=created_at.desc&limit=10" `
  -Headers $headers

Invoke-RestMethod -Method GET `
  -Uri "$restBase/rest/v1/leads_map?select=pf_event_id,pf_reference,zoho_lead_id,created_at&order=created_at.desc&limit=10" `
  -Headers $headers
```

## 14) Confirmed Working Milestone

This has been verified end-to-end:

1. `pf-webhook` accepts realistic payload with no Authorization header
2. `jobs-worker` processes queued `pf_lead_received`
3. Zoho lead is created and assigned to resolved owner
4. `leads_map` row is inserted
5. `jobs.result_json.action` is `"created"`
