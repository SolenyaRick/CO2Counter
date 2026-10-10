// Supabase Edge Function: receives Stripe webhooks and keeps
// public.memberships up to date, which is what unlocks the app (see
// has_access() in supabase/schema.sql).
//
// Stripe events to send here (Stripe dashboard → Developers → Webhooks):
//   checkout.session.completed          someone paid via the Payment Link
//   customer.subscription.updated       renewals, cancellations, failed cards
//   customer.subscription.deleted       subscription ended
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY       sk_live_... (or sk_test_... while testing)
//   STRIPE_WEBHOOK_SECRET   whsec_... from the webhook endpoint
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Deploy with JWT verification OFF: Stripe can't send a Supabase login, so
// requests are authenticated by checking Stripe's signature instead.

import { createClient } from "jsr:@supabase/supabase-js@2";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const SIGNATURE_TOLERANCE_SECONDS = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Implements Stripe's documented "Stripe-Signature" check: an HMAC-SHA256 of
// "<timestamp>.<raw body>" keyed with the endpoint's signing secret.
async function verifySignature(body: string, header: string | null): Promise<boolean> {
  if (!header || !STRIPE_WEBHOOK_SECRET) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const timestamp = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return signatures.some((s) => timingSafeEqual(s, expected));
}

async function stripeGet(path: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Newer Stripe API versions moved the billing period onto subscription items.
function periodEnd(sub: any): string | null {
  const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return end ? new Date(end * 1000).toISOString() : null;
}

const idOf = (v: any): string | null => (typeof v === "string" ? v : v?.id ?? null);

async function handleCheckoutCompleted(session: any) {
  const userId = session.client_reference_id;
  if (!userId || !UUID_RE.test(userId)) {
    console.warn("checkout.session.completed without a valid client_reference_id", session.id);
    return;
  }
  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return;
  const sub = await stripeGet(`subscriptions/${subscriptionId}`);
  const { error } = await supabase.from("memberships").upsert({
    user_id: userId,
    stripe_customer_id: idOf(session.customer),
    stripe_subscription_id: subscriptionId,
    status: sub.status,
    current_period_end: periodEnd(sub),
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function handleSubscriptionChange(sub: any) {
  const { error } = await supabase
    .from("memberships")
    .update({
      stripe_subscription_id: sub.id,
      status: sub.status,
      current_period_end: periodEnd(sub),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_customer_id", idOf(sub.customer));
  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.text();
  if (!(await verifySignature(body, req.headers.get("stripe-signature")))) {
    return new Response("Invalid signature", { status: 400 });
  }
  const event = JSON.parse(body);
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await handleSubscriptionChange(event.data.object);
        break;
    }
  } catch (e) {
    console.error(`Failed to handle ${event.type}`, e);
    // A 500 makes Stripe retry the event later.
    return new Response("Handler error", { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
