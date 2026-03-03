# lead-management

Supabase-based middleware for lead ingestion and async processing.

Detailed project docs:

- `docs/LEAD_MANAGEMENT_MIDDLEWARE_DOCS.md`

## Structure

- `supabase/migrations/` database migrations
- `supabase/functions/pf-webhook/` webhook ingestion function
- `supabase/functions/jobs-worker/` queued jobs worker
- `.github/workflows/jobs-worker-cron.yml` scheduler workflow

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

Invoke-RestMethod -Method POST `
  -Uri $pfWebhookUrl `
  -Headers @{ "Content-Type" = "application/json" } `
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
