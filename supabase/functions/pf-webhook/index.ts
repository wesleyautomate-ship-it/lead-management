import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JSON_HEADERS = { "Content-Type": "application/json" };

const getEventId = (payload: unknown): string => {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    const candidate = obj.eventId ?? obj.event_id ?? obj.id;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return crypto.randomUUID();
};

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers: { ...JSON_HEADERS, Allow: "POST" } },
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

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "invalid_json" }),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  const eventId = getEventId(payload);

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error } = await supabase.from("jobs").insert({
      type: "pf_lead_received",
      status: "queued",
      payload_json: {
        eventId,
        raw: payload,
      },
    });

    if (error) {
      throw error;
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  } catch (error) {
    console.error("pf-webhook failed", error);
    return new Response(
      JSON.stringify({ ok: false, error: "internal_error" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
});