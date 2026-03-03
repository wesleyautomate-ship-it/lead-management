# lead-management

Supabase-based middleware for lead ingestion and async processing.

Detailed project docs:

- `docs/LEAD_MANAGEMENT_MIDDLEWARE_DOCS.md`

## Structure

- `supabase/migrations/` database migrations
- `supabase/functions/pf-webhook/` webhook ingestion function
- `supabase/functions/jobs-worker/` queued jobs worker
- `.github/workflows/jobs-worker-cron.yml` scheduler workflow
- `.github/workflows/jobs-monitoring-alerts.yml` monitoring workflow

## Scheduling Strategy

Capability check in this repo/CLI:

- No native scheduling command found in `supabase functions` CLI.
- No existing repo-level Supabase scheduled function configuration found.

Implemented fallback:

- GitHub Actions scheduled workflow triggers `jobs-worker`.
- File: `.github/workflows/jobs-worker-cron.yml`

Important:

- GitHub scheduled workflows run at minimum every 5 minutes.
- Workflow compensates by calling `jobs-worker` once per minute for 5 minutes in each run.

## Required Environment Variables

Add to `.env.local`:

- `WORKER_CRON_SECRET=<strong-random-secret>`

Existing required values remain in `.env.local` (Supabase, PF, Zoho).

## GitHub Secrets Setup

In GitHub repository settings, add:

1. `SUPABASE_PROJECT_REF`
2. `WORKER_CRON_SECRET`
3. `SUPABASE_SERVICE_ROLE_KEY` (required for monitoring workflow)

Path:

- `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

## jobs-worker Trigger Protection

`jobs-worker` now checks header `x-cron-secret`:

- If `WORKER_CRON_SECRET` is missing in function env: `500 server_misconfigured`
- If header is missing or invalid: `401 invalid_cron_secret`
- If header matches `WORKER_CRON_SECRET`: allowed

## Deploy Flow

```powershell
supabase secrets set --env-file .env.local
supabase functions deploy jobs-worker --no-verify-jwt
```

## Verify Automation (Without Manual jobs-worker POST)

1. Create a test job by calling `pf-webhook`.
2. Wait 60-90 seconds (while scheduler should trigger worker).
3. Confirm job status moved to `success` and `result_json.action = "created"`.

### Test webhook call

```powershell
$pfWebhookUrl = "https://$($env:SUPABASE_PROJECT_REF).functions.supabase.co/pf-webhook"
$eventId = "evt-auto-$([Guid]::NewGuid().ToString('N').Substring(0,12))"

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
      "name": "Automation Test Lead",
      "contacts": [
        { "type": "phone", "value": "+971500000000" },
        { "type": "email", "value": "test@example.com" }
      ]
    }
  }
}
"@

$secret = [Text.Encoding]::UTF8.GetBytes($env:PF_WEBHOOK_SECRET)
$bodyBytes = [Text.Encoding]::UTF8.GetBytes($body)
$hmac = New-Object System.Security.Cryptography.HMACSHA256($secret)
$signature = ([BitConverter]::ToString($hmac.ComputeHash($bodyBytes))).Replace('-', '').ToLower()
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

Invoke-RestMethod -Method POST `
  -Uri $pfWebhookUrl `
  -Headers @{ "Content-Type" = "application/json"; "x-pf-signature" = $signature; "x-pf-timestamp" = "$timestamp" } `
  -Body $body
```

### Exact REST queries to check status

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

## Queue Monitoring Alerts

This repo includes a scheduled health-check workflow:

- File: `.github/workflows/jobs-monitoring-alerts.yml`
- Schedule: every 10 minutes
- Data source: monitoring SQL views in `public` schema
  - `v_jobs_status_counts`
  - `v_jobs_retry_or_failed`
  - `v_jobs_error_top_24h`
  - `v_jobs_stuck_processing`

Alert behavior:

- Workflow fails when retry/failed job count is above threshold.
- Workflow fails when stuck processing job count is above threshold.
- A failed run appears in GitHub Actions and can be connected to notifications.

Threshold defaults (in workflow env):

- `ALERT_RETRY_OR_FAILED_THRESHOLD=0`
- `ALERT_STUCK_THRESHOLD=0`
