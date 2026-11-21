// CO2 Counter: Sign in with Apple token keeping and revoking (Supabase Edge Function).
//
// Apple requires apps with Sign in with Apple to revoke the user's Apple
// tokens when they delete their account (App Store Review Guideline
// 5.1.1(v)). So:
//  - "store": straight after a Sign in with Apple, the app sends Apple's
//    one-time authorization code; we swap it for Apple's refresh token and
//    keep that (public.apple_tokens, service role only).
//  - "revoke": just before the account is deleted, we revoke that token
//    with Apple and forget it.
// The caller is the signed-in person (their Supabase access token).
//
// Secrets (Supabase > Edge Functions > Secrets):
//   APPLE_TEAM_ID      your 10-character Apple Team ID
//   APPLE_KEY_ID       the Key ID of a "Sign in with Apple" key
//   APPLE_PRIVATE_KEY  the contents of that key's .p8 file
//   APPLE_CLIENT_ID    optional, the app's bundle ID (default com.solenyarick.co2tracker)
//   APPLE_WEB_CLIENT_ID optional, the Services ID, only if Apple sign-in is on the website
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

const env = (k: string) => (globalThis as any).Deno.env.get(k);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function db(path: string, init: RequestInit = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(env("SUPABASE_URL") + "/rest/v1/" + path, {
    ...init,
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error("db " + res.status + " " + (await res.text()));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (t: string) => b64url(new TextEncoder().encode(t));

// Apple's "client secret" is a short-lived JWT signed with the .p8 key (ES256).
async function clientSecret(clientId: string) {
  const pem = String(env("APPLE_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (!body || !env("APPLE_TEAM_ID") || !env("APPLE_KEY_ID")) throw new Error("Apple secrets aren't set");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlText(JSON.stringify({ alg: "ES256", kid: env("APPLE_KEY_ID"), typ: "JWT" }));
  const claims = b64urlText(JSON.stringify({ iss: env("APPLE_TEAM_ID"), iat: now, exp: now + 300, aud: "https://appleid.apple.com", sub: clientId }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head + "." + claims)));
  return head + "." + claims + "." + b64url(sig);
}

async function apple(path: string, form: Record<string, string>) {
  const res = await fetch("https://appleid.apple.com/auth/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? (() => { try { return JSON.parse(text); } catch (_) { return { raw: text }; } })() : {} };
}

export const handler = async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    const ures = await fetch(env("SUPABASE_URL") + "/auth/v1/user", { headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: auth } });
    if (!ures.ok) return json({ error: "Sign in first" }, 401);
    const user = await ures.json();
    if (!user || !user.id) return json({ error: "Sign in first" }, 401);
    const body = await req.json().catch(() => ({}));
    const appId = env("APPLE_CLIENT_ID") || "com.solenyarick.co2tracker";
    const clientId = body.client === "web" && env("APPLE_WEB_CLIENT_ID") ? env("APPLE_WEB_CLIENT_ID") : appId;

    if (body.action === "store") {
      let refresh = typeof body.refresh_token === "string" ? body.refresh_token : "";
      if (!refresh && typeof body.code === "string" && body.code) {
        const r = await apple("token", { client_id: clientId, client_secret: await clientSecret(clientId), code: body.code, grant_type: "authorization_code" });
        if (!r.ok || !r.data.refresh_token) return json({ error: "Apple didn't swap the code", status: r.status, detail: r.data.error || "" }, 502);
        refresh = r.data.refresh_token;
      }
      if (!refresh) return json({ error: "Nothing to keep" }, 400);
      await db("apple_tokens?on_conflict=user_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ user_id: user.id, refresh_token: refresh, client_id: clientId, updated_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    if (body.action === "revoke") {
      const rows = await db("apple_tokens?select=refresh_token,client_id&user_id=eq." + user.id);
      if (!rows.length) return json({ ok: true, revoked: false });
      const row = rows[0];
      const r = await apple("revoke", { client_id: row.client_id, client_secret: await clientSecret(row.client_id), token: row.refresh_token, token_type_hint: "refresh_token" });
      if (!r.ok) return json({ error: "Apple didn't revoke it", status: r.status }, 502);
      await db("apple_tokens?user_id=eq." + user.id, { method: "DELETE" });
      return json({ ok: true, revoked: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
};

if ((globalThis as any).Deno && (globalThis as any).Deno.serve) (globalThis as any).Deno.serve(handler);
export { clientSecret };
