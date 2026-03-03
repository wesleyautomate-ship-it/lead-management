import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JSON_HEADERS = { "Content-Type": "application/json" };
const encoder = new TextEncoder();

const getEnvVar = (name: string): string | null => {
  const value = Deno.env.get(name)?.trim();
  return value && value.length > 0 ? value : null;
};

const toHex = (bytes: Uint8Array): string => {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

const normalizeSignature = (signature: string): string => {
  const trimmed = signature.trim();
  return trimmed.startsWith("sha256=") ? trimmed.slice(7) : trimmed;
};

const getProvidedSignature = (req: Request): string | null => {
  const configuredHeader = getEnvVar("PF_WEBHOOK_SIGNATURE_HEADER") ??
    "x-pf-signature";
  const fallbackHeaders = [
    configuredHeader,
    "x-pf-signature",
    "x-propertyfinder-signature",
    "x-signature",
  ];

  for (const headerName of new Set(fallbackHeaders)) {
    const value = req.headers.get(headerName);
    if (value && value.trim().length > 0) {
      return normalizeSignature(value);
    }
  }

  return null;
};

const buildExpectedSignatures = async (
  secret: string,
  body: string,
): Promise<{ hex: string; base64: string }> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const bytes = new Uint8Array(signed);
  return {
    hex: toHex(bytes),
    base64: toBase64(bytes),
  };
};

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

  const webhookSecret = getEnvVar("PF_WEBHOOK_SECRET");
  if (!webhookSecret) {
    console.error("Missing PF_WEBHOOK_SECRET");
    return new Response(
      JSON.stringify({ ok: false, error: "server_misconfigured" }),
      { status: 500, headers: JSON_HEADERS },
    );
  }

  const providedSignature = getProvidedSignature(req);
  if (!providedSignature) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing_signature" }),
      { status: 401, headers: JSON_HEADERS },
    );
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "invalid_body" }),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  const expected = await buildExpectedSignatures(webhookSecret, rawBody);
  const validSignature = constantTimeEqual(providedSignature, expected.hex) ||
    constantTimeEqual(providedSignature, expected.base64);

  if (!validSignature) {
    return new Response(
      JSON.stringify({ ok: false, error: "invalid_signature" }),
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

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
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
