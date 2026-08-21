import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(
  supabaseUrl,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const allowedOrigins = new Set([
  "https://ganlu6633-source.github.io",
  "http://localhost:4173",
  "http://localhost:5173",
]);

function responseHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://ganlu6633-source.github.io",
    "Access-Control-Allow-Headers": "apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function reply(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(req),
  });
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function singleRow(value: unknown) {
  if (Array.isArray(value)) return value[0] as Record<string, unknown> | undefined;
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(req) });
  }
  if (req.method !== "POST") {
    return reply(req, { error: "仅支持 POST 请求。" }, 405);
  }

  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply(req, { error: "请求格式不正确。" }, 400);
    }
    const payload = body as Record<string, unknown>;
    const name = cleanText(payload.name, 30);
    const code = cleanText(payload.code, 20);
    if (!name || !/^\d{6,12}$/.test(code)) {
      return reply(req, { error: "请填写教师名称和 6 至 12 位数字密码。" }, 400);
    }

    const appSessionToken = randomToken();
    const fingerprint = await sha256([
      req.headers.get("x-forwarded-for") || "",
      req.headers.get("user-agent") || "",
      req.headers.get("accept-language") || "",
    ].join("|"));
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const exchanged = await admin.rpc("chem_exchange_access_code", {
      p_name: name,
      p_code: code,
      p_fingerprint_hash: fingerprint,
      p_token_hash: await sha256(appSessionToken),
      p_expires_at: expiresAt,
    });
    const access = singleRow(exchanged.data);
    if (exchanged.error || !access || access.access_role !== "teacher") {
      return reply(req, { error: "教师名称或密码不正确。" }, 401);
    }

    const allowlist = await admin
      .from("sched_teacher_allowlist")
      .select("email")
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (allowlist.error || !allowlist.data?.email) {
      return reply(req, { error: "教师账号尚未启用。" }, 403);
    }

    const link = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: String(allowlist.data.email),
      options: {
        redirectTo: "https://ganlu6633-source.github.io/gan-schedule/#/teacher",
      },
    });
    const tokenHash = link.data.properties?.hashed_token;
    if (link.error || !tokenHash) {
      console.error("schedule teacher auth link", link.error?.message || "missing token hash");
      return reply(req, { error: "教师登录会话建立失败，请稍后重试。" }, 500);
    }

    return reply(req, {
      tokenHash,
      appSessionToken,
      displayName: String(access.principal_name || name),
      expiresAt,
    });
  } catch (error) {
    console.error("chemistry-schedule-teacher-login", error);
    return reply(req, { error: "教师登录服务暂时不可用。" }, 500);
  }
});
