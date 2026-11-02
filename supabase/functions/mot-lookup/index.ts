// CO2 Counter: yearly mileage from a number plate (Supabase Edge Function).
//
// Uses the DVSA MOT History API: the odometer readings at each MOT give the
// miles a year. Signed-in people only. The number plate isn't stored.
//
// Secrets (Supabase > Edge Functions > Secrets), from DVSA's welcome email:
//   MOT_CLIENT_ID, MOT_CLIENT_SECRET, MOT_API_KEY, MOT_TOKEN_URL
//   (the full token URL, https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token)
// Until they're set, the app hides the lookup ({ enabled: false }).

const env = (k: string) => (globalThis as any).Deno.env.get(k);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const enabled = () => !!(env("MOT_CLIENT_ID") && env("MOT_CLIENT_SECRET") && env("MOT_API_KEY") && env("MOT_TOKEN_URL"));

let tokenCache: { token: string; until: number } | null = null;
async function accessToken() {
  if (tokenCache && Date.now() < tokenCache.until) return tokenCache.token;
  const res = await fetch(env("MOT_TOKEN_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env("MOT_CLIENT_ID"),
      client_secret: env("MOT_CLIENT_SECRET"),
      scope: "https://tapi.dvsa.gov.uk/.default",
    }),
  });
  if (!res.ok) throw new Error("token " + res.status);
  const out = await res.json();
  tokenCache = { token: out.access_token, until: Date.now() + Math.max(60, (out.expires_in || 3600) - 300) * 1000 };
  return tokenCache.token;
}

const MILES_PER_KM = 0.621371;
const DAY = 86400000;

// Miles a year from MOT odometer readings: the two latest readings at least
// ten months apart, or, with one reading, the miles since first registered.
export function milesPerYear(v: any): number | null {
  const reads = (v.motTests || [])
    .filter((t: any) => t && t.odometerResultType === "READ" && Number(t.odometerValue) > 0 && t.completedDate)
    .map((t: any) => ({ at: new Date(t.completedDate).getTime(), miles: Number(t.odometerValue) * (String(t.odometerUnit).toUpperCase() === "KM" ? MILES_PER_KM : 1) }))
    .sort((a: any, b: any) => b.at - a.at);
  if (!reads.length) return null;
  const latest = reads[0];
  const earlier = reads.find((r: any) => latest.at - r.at >= 300 * DAY && r.miles <= latest.miles);
  if (earlier) return Math.round((latest.miles - earlier.miles) / ((latest.at - earlier.at) / (365.25 * DAY)));
  const first = new Date(v.firstUsedDate || v.registrationDate || "").getTime();
  if (first && latest.at - first >= 300 * DAY) return Math.round(latest.miles / ((latest.at - first) / (365.25 * DAY)));
  return null;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.ping) return json({ enabled: enabled() });
    if (!enabled()) return json({ enabled: false, error: "The number plate lookup isn't switched on yet." }, 503);
    const auth = req.headers.get("Authorization") || "";
    const ures = await fetch(env("SUPABASE_URL") + "/auth/v1/user", { headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: auth } });
    if (!ures.ok) return json({ error: "Please sign in to look up a number plate." }, 401);
    const reg = String(body.reg || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z0-9]{2,8}$/.test(reg)) return json({ error: "Please check the number plate." }, 400);
    const res = await fetch("https://history.mot.api.gov.uk/v1/trade/vehicles/registration/" + reg, {
      headers: { Authorization: "Bearer " + (await accessToken()), "X-API-Key": env("MOT_API_KEY"), Accept: "application/json" },
    });
    if (res.status === 404) return json({ error: "We couldn't find that number plate in the MOT records. New cars don't have an MOT until they're three years old." }, 404);
    if (!res.ok) throw new Error("mot " + res.status);
    const v = await res.json();
    return json({
      ok: true,
      make: v.make || "",
      model: v.model || "",
      fuelType: v.fuelType || "",
      milesPerYear: milesPerYear(v),
    });
  } catch (e) {
    console.error(e);
    return json({ error: "Couldn't look that up just now. Please try again, or enter the miles yourself." }, 500);
  }
}

if ((globalThis as any).Deno && (globalThis as any).Deno.serve) (globalThis as any).Deno.serve(handler);
