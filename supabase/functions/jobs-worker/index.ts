import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Job = {
  id: string;
  type: string;
  payload_json: unknown;
  attempts: number;
  max_attempts: number;
};

type OwnerResolution = {
  ownerId: string;
  ownerName: string | null;
  source: "listings_map" | "zoho_listing" | "fallback";
};

type PfLeadDetails = {
  eventId: string;
  pfLeadId: string;
  pfReference: string | null;
  pfListingId: string | null;
  senderName: string | null;
  phone: string | null;
  email: string | null;
  channel: string | null;
  responseLink: string | null;
  raw: Record<string, unknown>;
};

const JSON_HEADERS = { "Content-Type": "application/json" };
const RETRY_DELAY_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

let zohoTokenCache: { token: string; expiresAtMs: number } | null = null;

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getEnvVar = (name: string, fallback?: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (value && value.length > 0) {
    return value;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(`missing_env:${name}`);
};

const getContactValue = (
  contacts: unknown,
  contactType: "phone" | "email",
): string | null => {
  if (!Array.isArray(contacts)) {
    return null;
  }

  for (const entry of contacts) {
    const row = asObject(entry);
    if (!row) {
      continue;
    }

    const type = asString(row.type)?.toLowerCase();
    const value = asString(row.value);
    if (type === contactType && value) {
      return value;
    }
  }

  return null;
};

const parsePfLeadDetails = (payloadJson: unknown): PfLeadDetails => {
  const envelope = asObject(payloadJson) ?? {};
  const raw = asObject(envelope.raw) ?? envelope;
  const rootEntity = asObject(raw.entity) ?? {};
  const payload = asObject(raw.payload) ?? {};
  const listing = asObject(payload.listing) ?? {};
  const sender = asObject(payload.sender) ?? {};

  const eventId = asString(envelope.eventId) ??
    asString(raw.id) ??
    crypto.randomUUID();
  const pfLeadId = asString(rootEntity.id) ?? eventId;

  return {
    eventId,
    pfLeadId,
    pfReference: asString(listing.reference),
    pfListingId: asString(listing.id),
    senderName: asString(sender.name),
    phone: getContactValue(sender.contacts, "phone"),
    email: getContactValue(sender.contacts, "email"),
    channel: asString(payload.channel),
    responseLink: asString(payload.responseLink),
    raw,
  };
};

const getZohoAccessToken = async (): Promise<string> => {
  if (
    zohoTokenCache &&
    Date.now() + TOKEN_EXPIRY_BUFFER_MS < zohoTokenCache.expiresAtMs
  ) {
    return zohoTokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: getEnvVar("ZOHO_CLIENT_ID"),
    client_secret: getEnvVar("ZOHO_CLIENT_SECRET"),
    refresh_token: getEnvVar("ZOHO_REFRESH_TOKEN"),
  });

  const response = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const payload = await response.json().catch(() => ({}));
  const payloadObj = asObject(payload) ?? {};

  if (!response.ok) {
    throw new Error(
      `zoho_auth_failed:${response.status}:${JSON.stringify(payloadObj)}`,
    );
  }

  const token = asString(payloadObj.access_token);
  if (!token) {
    throw new Error(`zoho_auth_missing_access_token:${JSON.stringify(payloadObj)}`);
  }

  const expiresInSec = Number(payloadObj.expires_in) || 3600;
  zohoTokenCache = {
    token,
    expiresAtMs: Date.now() + (expiresInSec * 1000),
  };

  return token;
};

const zohoRequest = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> => {
  const apiDomain = getEnvVar("ZOHO_API_DOMAIN").replace(/\/+$/, "");
  const url = `${apiDomain}${path}`;

  const doRequest = async (
    forceRefreshToken: boolean,
  ): Promise<Record<string, unknown>> => {
    if (forceRefreshToken) {
      zohoTokenCache = null;
    }

    const token = await getZohoAccessToken();
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Zoho-oauthtoken ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let payload: unknown = {};
    if (text.trim().length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }

    if (response.status === 401 && !forceRefreshToken) {
      return await doRequest(true);
    }

    if (!response.ok) {
      throw new Error(
        `zoho_request_failed:${method}:${path}:${response.status}:${JSON.stringify(payload)}`,
      );
    }

    const payloadObj = asObject(payload);
    return payloadObj ?? {};
  };

  return await doRequest(false);
};

const resolveListingOwner = async (
  supabase: ReturnType<typeof createClient>,
  pfReference: string | null,
  pfListingId: string | null,
): Promise<OwnerResolution> => {
  const fallbackOwnerId = getEnvVar("ZOHO_FALLBACK_OWNER_USER_ID");

  if (pfReference) {
    const { data: mappedListing, error: mappedListingError } = await supabase
      .from("listings_map")
      .select("zoho_owner_user_id, zoho_owner_name")
      .eq("pf_reference", pfReference)
      .maybeSingle();

    if (mappedListingError) {
      throw new Error(`listings_map_lookup_failed:${mappedListingError.message}`);
    }

    const mappedOwnerId = asString(mappedListing?.zoho_owner_user_id);
    if (mappedOwnerId) {
      return {
        ownerId: mappedOwnerId,
        ownerName: asString(mappedListing?.zoho_owner_name),
        source: "listings_map",
      };
    }

    const listingsModule = getEnvVar("ZOHO_LISTINGS_MODULE_API_NAME", "Listings");
    const listingPfRefField = getEnvVar(
      "ZOHO_LISTING_PF_REFERENCE_FIELD_API_NAME",
      "PF_Reference",
    );
    let records: unknown[] = [];
    const criteria = `(${listingPfRefField}:equals:${pfReference})`;
    const searchPath =
      `/crm/v4/${encodeURIComponent(listingsModule)}/search?criteria=${
        encodeURIComponent(criteria)
      }`;

    try {
      const searchResponse = await zohoRequest("GET", searchPath);
      records = Array.isArray(searchResponse.data) ? searchResponse.data : [];
    } catch (searchError) {
      const searchErrorMsg = toErrorMessage(searchError);
      const shouldFallbackToCoql = searchErrorMsg.includes("INVALID_QUERY") ||
        searchErrorMsg.includes("field is not available for search");

      if (!shouldFallbackToCoql) {
        throw searchError;
      }

      const escapedReference = pfReference.replace(/'/g, "\\'");
      const coqlQuery =
        `select id, Owner from ${listingsModule} where ${listingPfRefField} = '${escapedReference}' limit 1`;
      const coqlResponse = await zohoRequest("POST", "/crm/v4/coql", {
        select_query: coqlQuery,
      });
      records = Array.isArray(coqlResponse.data) ? coqlResponse.data : [];
    }
    const firstRecord = asObject(records[0]) ?? {};
    const owner = asObject(firstRecord.Owner) ?? {};
    const ownerId = asString(owner.id);
    const ownerName = asString(owner.name);
    const zohoListingId = asString(firstRecord.id) ?? pfListingId ??
      `fallback:${pfReference}`;

    if (ownerId) {
      const { error: upsertError } = await supabase
        .from("listings_map")
        .upsert({
          pf_reference: pfReference,
          pf_listing_id: pfListingId,
          zoho_listing_id: zohoListingId,
          zoho_owner_user_id: ownerId,
          zoho_owner_name: ownerName,
          status: "active",
        }, { onConflict: "pf_reference" });

      if (upsertError) {
        throw new Error(`listings_map_upsert_failed:${upsertError.message}`);
      }

      return {
        ownerId,
        ownerName,
        source: "zoho_listing",
      };
    }
  }

  if (pfReference) {
    const fallbackListingId = pfListingId ?? `fallback:${pfReference}`;
    const { error: fallbackUpsertError } = await supabase
      .from("listings_map")
      .upsert({
        pf_reference: pfReference,
        pf_listing_id: pfListingId,
        zoho_listing_id: fallbackListingId,
        zoho_owner_user_id: fallbackOwnerId,
        zoho_owner_name: null,
        status: "fallback",
      }, { onConflict: "pf_reference" });

    if (fallbackUpsertError) {
      console.error("Failed to upsert fallback listings_map row", {
        pfReference,
        error: fallbackUpsertError,
      });
    }
  }

  return {
    ownerId: fallbackOwnerId,
    ownerName: null,
    source: "fallback",
  };
};

const createZohoLead = async (
  ownerId: string,
  lead: PfLeadDetails,
): Promise<string> => {
  const leadsModule = getEnvVar("ZOHO_LEADS_MODULE_API_NAME", "Leads");
  const leadPfRefField = getEnvVar(
    "ZOHO_LEAD_PF_REFERENCE_FIELD_API_NAME",
    "PF_Reference",
  );
  const leadPfResponseLinkField = getEnvVar(
    "ZOHO_LEAD_PF_RESPONSE_LINK_FIELD_API_NAME",
    "PF_Response_Link",
  );
  const leadPfChannelField = getEnvVar(
    "ZOHO_LEAD_PF_CHANNEL_FIELD_API_NAME",
    "PF_Channel",
  );

  const leadPayload: Record<string, unknown> = {
    Last_Name: lead.senderName ?? "PropertyFinder Lead",
    Owner: { id: ownerId },
  };

  if (lead.email) {
    leadPayload.Email = lead.email;
  }
  if (lead.phone) {
    leadPayload.Phone = lead.phone;
  }
  if (lead.pfReference) {
    leadPayload[leadPfRefField] = lead.pfReference;
  }
  if (lead.responseLink) {
    leadPayload[leadPfResponseLinkField] = lead.responseLink;
  }
  if (lead.channel) {
    leadPayload[leadPfChannelField] = lead.channel;
  }

  const response = await zohoRequest(
    "POST",
    `/crm/v4/${encodeURIComponent(leadsModule)}`,
    { data: [leadPayload] },
  );

  const responseRows = Array.isArray(response.data) ? response.data : [];
  const firstRow = asObject(responseRows[0]) ?? {};
  const firstCode = asString(firstRow.code);
  const details = asObject(firstRow.details) ?? {};
  const leadId = asString(details.id);

  if (firstCode && firstCode !== "SUCCESS") {
    throw new Error(`zoho_lead_create_failed:${JSON.stringify(firstRow)}`);
  }

  if (!leadId) {
    throw new Error(`zoho_lead_create_missing_id:${JSON.stringify(response)}`);
  }

  return leadId;
};

const processPfLeadReceivedJob = async (
  supabase: ReturnType<typeof createClient>,
  job: Job,
): Promise<Record<string, unknown>> => {
  const lead = parsePfLeadDetails(job.payload_json);

  const { data: existingMapping, error: existingMappingError } = await supabase
    .from("leads_map")
    .select("pf_event_id, zoho_lead_id")
    .eq("pf_event_id", lead.eventId)
    .maybeSingle();

  if (existingMappingError) {
    throw new Error(`leads_map_lookup_failed:${existingMappingError.message}`);
  }

  if (existingMapping) {
    return {
      action: "duplicate",
      pf_event_id: lead.eventId,
      pf_reference: lead.pfReference,
      zoho_lead_id: existingMapping.zoho_lead_id ?? null,
    };
  }

  const owner = await resolveListingOwner(
    supabase,
    lead.pfReference,
    lead.pfListingId,
  );
  const zohoLeadId = await createZohoLead(owner.ownerId, lead);

  const { error: insertLeadMapError } = await supabase
    .from("leads_map")
    .insert({
      pf_event_id: lead.eventId,
      pf_reference: lead.pfReference,
      zoho_lead_id: zohoLeadId,
    });

  if (insertLeadMapError) {
    if (insertLeadMapError.code === "23505") {
      return {
        action: "duplicate",
        pf_event_id: lead.eventId,
        pf_reference: lead.pfReference,
        zoho_lead_id: zohoLeadId,
      };
    }
    throw new Error(`leads_map_insert_failed:${insertLeadMapError.message}`);
  }

  return {
    action: "created",
    zoho_lead_id: zohoLeadId,
    assigned_owner_id: owner.ownerId,
    assigned_owner_source: owner.source,
    pf_reference: lead.pfReference,
    pf_event_id: lead.eventId,
  };
};

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: { ...JSON_HEADERS, Allow: "POST" } },
    );
  }

  const expectedCronSecret = Deno.env.get("WORKER_CRON_SECRET")?.trim();
  const providedCronSecret = req.headers.get("x-cron-secret")?.trim();

  if (!providedCronSecret) {
    console.warn(
      "jobs-worker called without x-cron-secret header; allowing in test mode",
    );
  } else if (!expectedCronSecret) {
    console.warn(
      "x-cron-secret header provided but WORKER_CRON_SECRET is not configured; allowing in test mode",
    );
  } else if (providedCronSecret !== expectedCronSecret) {
    console.warn("jobs-worker called with invalid x-cron-secret");
    return new Response(
      JSON.stringify({ ok: false, error: "invalid_cron_secret" }),
      { status: 401, headers: JSON_HEADERS },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return new Response(
      JSON.stringify({ ok: false, error: "server_misconfigured" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const nowIso = new Date().toISOString();
    const { data: queuedJobs, error: fetchError } = await supabase
      .from("jobs")
      .select("id, type, payload_json, attempts, max_attempts")
      .eq("status", "queued")
      .lte("run_after", nowIso)
      .order("run_after", { ascending: true })
      .limit(10);

    if (fetchError) {
      throw fetchError;
    }

    if (!queuedJobs || queuedJobs.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, fetched: 0, processed: 0, failed: 0, skipped: 0 }),
        { status: 200, headers: JSON_HEADERS },
      );
    }

    let processed = 0;
    let failed = 0;
    let skipped = 0;

    for (const rawJob of queuedJobs) {
      const claimTime = new Date().toISOString();

      const { data: claimedJob, error: claimError } = await supabase
        .from("jobs")
        .update({
          status: "processing",
          locked_at: claimTime,
          locked_by: "jobs-worker",
          updated_at: claimTime,
        })
        .eq("id", rawJob.id)
        .eq("status", "queued")
        .select("id, type, payload_json, attempts, max_attempts")
        .maybeSingle();

      if (claimError) {
        console.error("Failed to claim job", { jobId: rawJob.id, claimError });
        skipped += 1;
        continue;
      }

      if (!claimedJob) {
        skipped += 1;
        continue;
      }

      const job = claimedJob as Job;

      try {
        let resultJson: Record<string, unknown>;

        if (job.type === "pf_lead_received") {
          resultJson = await processPfLeadReceivedJob(supabase, job);
          console.log("Processed pf_lead_received", {
            jobId: job.id,
            result: resultJson,
          });
        } else {
          throw new Error(`unsupported_job_type:${job.type}`);
        }

        const doneAt = new Date().toISOString();
        const { error: successError } = await supabase
          .from("jobs")
          .update({
            status: "success",
            last_error: null,
            result_json: resultJson,
            locked_at: null,
            locked_by: null,
            updated_at: doneAt,
          })
          .eq("id", job.id)
          .eq("status", "processing");

        if (successError) {
          throw successError;
        }

        processed += 1;
      } catch (error) {
        failed += 1;

        const retryAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
        const attempts = (job.attempts ?? 0) + 1;
        const errorMessage = toErrorMessage(error).slice(0, 4000);

        const { error: retryError } = await supabase
          .from("jobs")
          .update({
            attempts,
            status: "queued",
            run_after: retryAt,
            last_error: errorMessage,
            result_json: { action: "failed" },
            locked_at: null,
            locked_by: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);

        if (retryError) {
          console.error("Failed to requeue job", {
            jobId: job.id,
            retryError,
          });
        }
      }
    }

    return new Response(
      JSON.stringify({ ok: true, fetched: queuedJobs.length, processed, failed, skipped }),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (error) {
    console.error("jobs-worker failed", error);
    return new Response(
      JSON.stringify({ ok: false, error: "internal_error" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
});
