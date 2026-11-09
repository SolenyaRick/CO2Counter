// CO2 Counter: push notifications for the friends feed (Supabase Edge Function).
//
// The app (or website) calls this right after something happens, and it
// checks the database itself before telling anyone:
//  - "survey": you finished a survey -> your friends hear about it.
//  - "cheer":  you cheered a post    -> its owner hears about it.
//  - "friend": you accepted a request -> the person who asked hears about it.
// Each event is sent once (push_sent), only to people with a saved push
// token (push_tokens), straight to Apple's push service (APNs).
//
// Secrets (Supabase > Edge Functions > Secrets):
//   APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY (the whole .p8 file),
//   optionally APNS_BUNDLE_ID (default com.solenyarick.co2tracker).
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

// Claim an event; false if it was already sent.
async function claim(key: string) {
  const rows = await db("push_sent", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ event_key: key }),
  });
  return Array.isArray(rows) && rows.length > 0;
}

async function nameOf(userId: string) {
  const rows = await db("profiles?select=display_name,username&id=eq." + userId);
  const p = rows[0] || {};
  return (p.display_name || "").trim() || p.username || "A friend";
}

async function friendsOf(userId: string) {
  const rows = await db("friendships?select=requester_id,addressee_id&status=eq.accepted&or=(requester_id.eq." + userId + ",addressee_id.eq." + userId + ")");
  return rows.map((r: any) => (r.requester_id === userId ? r.addressee_id : r.requester_id));
}

// ---------- APNs ----------
const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let jwtCache: { token: string; at: number } | null = null;
async function apnsJwt() {
  if (jwtCache && Date.now() - jwtCache.at < 50 * 60 * 1000) return jwtCache.token;
  const pem = String(env("APNS_PRIVATE_KEY") || "").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: env("APNS_KEY_ID") })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: env("APNS_TEAM_ID"), iat: Math.floor(Date.now() / 1000) })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims)));
  jwtCache = { token: head + "." + claims + "." + b64url(sig), at: Date.now() };
  return jwtCache.token;
}

// App Store and TestFlight builds use Apple's production service; builds
// run from Xcode use the sandbox, so a token production rejects is retried there.
async function sendApns(token: string, payload: unknown): Promise<"ok" | "gone" | string> {
  const jwt = await apnsJwt();
  for (const host of ["api.push.apple.com", "api.sandbox.push.apple.com"]) {
    const res = await fetch("https://" + host + "/3/device/" + token, {
      method: "POST",
      headers: {
        authorization: "bearer " + jwt,
        "apns-topic": env("APNS_BUNDLE_ID") || "com.solenyarick.co2tracker",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) return "ok";
    const reason = ((await res.json().catch(() => ({}))) as any).reason || String(res.status);
    if (reason === "BadDeviceToken" && host === "api.push.apple.com") continue;
    if (res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") return "gone";
    return "error " + reason;
  }
  return "gone";
}

async function notify(userIds: string[], title: string, body: string, route: string) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length || !env("APNS_PRIVATE_KEY")) return 0;
  const tokens = await db("push_tokens?select=token,platform&platform=eq.ios&user_id=in.(" + ids.join(",") + ")");
  let sent = 0;
  for (const t of tokens) {
    const out = await sendApns(t.token, { aps: { alert: { title, body }, sound: "default" }, route });
    if (out === "ok") sent++;
    else if (out === "gone") await db("push_tokens?token=eq." + encodeURIComponent(t.token), { method: "DELETE" });
    else console.error("apns", out);
  }
  return sent;
}

const tonnes = (kg: number) => (kg / 1000).toFixed(1);
const kgFmt = (kg: number) => Math.round(kg).toLocaleString("en-GB");
const RECENT = 15 * 60 * 1000;

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    const ures = await fetch(env("SUPABASE_URL") + "/auth/v1/user", { headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: auth } });
    if (!ures.ok) return json({ error: "Please sign in again." }, 401);
    const me = (await ures.json()).id as string;
    if (!me) return json({ error: "Please sign in again." }, 401);
    const body = await req.json().catch(() => ({}));

    // A test push to your own phone, saying what went wrong if it fails.
    if (body.kind === "test") {
      if (!env("APNS_PRIVATE_KEY") || !env("APNS_KEY_ID") || !env("APNS_TEAM_ID")) return json({ ok: false, problem: "server" });
      if (!(await claim("test:" + me + ":" + Math.floor(Date.now() / 20000)))) return json({ ok: false, problem: "wait" });
      const tokens = await db("push_tokens?select=token&platform=eq.ios&user_id=eq." + me);
      if (!tokens.length) return json({ ok: false, problem: "no-token" });
      const results: string[] = [];
      for (const t of tokens) {
        try {
          results.push(await sendApns(t.token, { aps: { alert: { title: "CO2 Counter", body: "Push notifications are working. You'll hear when friends cheer you on." }, sound: "default" }, route: "#/account" }));
        } catch (e) {
          results.push("error " + String((e as any)?.message || e));
        }
      }
      return json({ ok: results.includes("ok"), sent: results.filter((r) => r === "ok").length, results });
    }

    if (body.kind === "survey") {
      const rows = await db("survey_history?select=id,total_yearly,completed_at&user_id=eq." + me + "&total_yearly=not.is.null&order=completed_at.desc&limit=2");
      const latest = rows[0];
      if (!latest || Date.now() - new Date(latest.completed_at).getTime() > RECENT) return json({ ok: true, sent: 0 });
      const prev = rows[1];
      const after = Number(latest.total_yearly), before = prev ? Number(prev.total_yearly) : null;
      // A retake that changed nothing isn't news (the feed leaves it out too).
      if (before != null && Math.round(after - before) === 0) return json({ ok: true, sent: 0 });
      if (!(await claim("survey:" + latest.id))) return json({ ok: true, sent: 0 });
      const name = await nameOf(me);
      let title: string, text: string;
      if (before == null) {
        title = name + " measured their footprint";
        text = tonnes(after) + " t a year. See how you compare.";
      } else {
        const pct = before > 0 ? Math.round((Math.abs(after - before) / before) * 100) : 0;
        title = name + " retook the survey";
        text = after < before ? "Down " + pct + "%, " + kgFmt(before - after) + " kg a year less. Send a cheer?" : "Their footprint went up " + pct + "%. Send some encouragement?";
      }
      return json({ ok: true, sent: await notify(await friendsOf(me), title, text, "#/friends") });
    }

    if (body.kind === "cheer") {
      const key = String(body.key || "");
      if (!/^[hf][0-9a-f-]{1,40}$/.test(key)) return json({ error: "Bad post" }, 400);
      const cheer = await db("feed_cheers?select=created_at&post_key=eq." + key + "&user_id=eq." + me);
      if (!cheer.length || Date.now() - new Date(cheer[0].created_at).getTime() > RECENT) return json({ ok: true, sent: 0 });
      let owner: string | null = null, what = "your post";
      if (key[0] === "h") {
        const h = await db("survey_history?select=user_id&id=eq." + key.slice(1));
        owner = h[0] && h[0].user_id;
        what = "your latest survey";
      } else {
        const f = await db("friendships?select=requester_id,addressee_id&id=eq." + key.slice(1));
        if (f[0] && (f[0].requester_id === me || f[0].addressee_id === me)) owner = f[0].requester_id === me ? f[0].addressee_id : f[0].requester_id;
        what = "your new friendship";
      }
      if (!owner || owner === me) return json({ ok: true, sent: 0 });
      if (!(await claim("cheer:" + key + ":" + me))) return json({ ok: true, sent: 0 });
      return json({ ok: true, sent: await notify([owner], (await nameOf(me)) + " cheered you on", "They cheered " + what + " on CO2 Counter.", "#/friends") });
    }

    if (body.kind === "friend") {
      const id = String(body.id || "");
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "Bad request" }, 400);
      const f = await db("friendships?select=requester_id,addressee_id,status&id=eq." + id);
      if (!f[0] || f[0].status !== "accepted" || f[0].addressee_id !== me) return json({ ok: true, sent: 0 });
      if (!(await claim("friend:" + id))) return json({ ok: true, sent: 0 });
      return json({ ok: true, sent: await notify([f[0].requester_id], (await nameOf(me)) + " accepted your friend request", "See how your footprints compare.", "#/friends") });
    }
    return json({ error: "Unknown kind" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Couldn't send notifications." }, 500);
  }
}

if ((globalThis as any).Deno && (globalThis as any).Deno.serve) (globalThis as any).Deno.serve(handler);
