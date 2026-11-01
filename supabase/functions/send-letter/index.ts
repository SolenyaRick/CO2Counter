// CO2 Counter: send a letter from the app (Supabase Edge Function).
//
// Two kinds, both sent through Resend from our own domain, with replies going
// to the person who wrote it and a copy to them:
//  - "mp": the MP is looked up again here from the postcode (Parliament's
//    members API), so letters can only go to a real MP. Sending verifies the
//    person's Act 6 straight away.
//  - "energy": a message to whoever chooses the energy supplier, with the
//    person's private "we've switched" link added (Act 2).
// Limits: one MP letter a week, three energy messages a day, per person.
//
// Secrets (Supabase > Edge Functions > Secrets): RESEND_API_KEY, and
// optionally LETTERS_FROM (default "CO2 Counter <letters@co2counter.co.uk>": Resend verifies
// co2counter.co.uk itself; "send." only holds its bounce records).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

const env = (k: string) => (globalThis as any).Deno.env.get(k);
const SITE = "https://co2counter.co.uk/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\r/g, "").trim().slice(0, max);
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

// Supabase REST with the service role (bypasses RLS; this code is the only door).
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

async function sentSince(userId: string, kind: string, ms: number) {
  const since = new Date(Date.now() - ms).toISOString();
  const rows = await db("letters_sent?select=id&user_id=eq." + userId + "&kind=eq." + kind + "&sent_at=gte." + encodeURIComponent(since));
  return rows.length;
}

async function findMp(postcode: string) {
  const api = "https://members-api.parliament.uk/api/";
  const found = await (await fetch(api + "Location/Constituency/Search?take=1&searchText=" + encodeURIComponent(postcode))).json();
  const c = found.items && found.items[0] && found.items[0].value;
  const m = c && c.currentRepresentation && c.currentRepresentation.member && c.currentRepresentation.member.value;
  if (!m) return null;
  const contact = await (await fetch(api + "Members/" + m.id + "/Contact")).json();
  const emails = (contact.value || []).filter((x: any) => x.email && /@parliament\.uk$/i.test(x.email));
  const email = (emails.find((x: any) => /parliament/i.test(x.type || "")) || emails[0] || {}).email;
  return email ? { name: m.nameDisplayAs, constituency: c.name, email } : null;
}

async function energyToken(userId: string) {
  const rows = await db("energy_asks?select=token&user_id=eq." + userId);
  if (rows.length) return rows[0].token;
  const token = crypto.randomUUID().replace(/-/g, "");
  await db("energy_asks", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ user_id: userId, token }) });
  return (await db("energy_asks?select=token&user_id=eq." + userId))[0].token;
}

// Mail that looks personal lands in the inbox more often: the sender's own
// name in the From line, and a plain HTML version alongside the text.
const fromFor = (name: string) => {
  const base = env("LETTERS_FROM") || "CO2 Counter <letters@co2counter.co.uk>";
  const addr = (base.match(/<([^>]+)>/) || [, base])[1];
  const who = name.replace(/["<>\\\r\n]/g, "").slice(0, 60);
  return who ? '"' + who + ' via CO2 Counter" <' + addr + ">" : base;
};
const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Links to the suppliers we suggest (and our own site) become clickable.
// Only these hosts, so a message can't be used to send anyone else's link.
const LINK_HOSTS = /https:\/\/(?:www\.)?(?:goodenergy\.co\.uk|ecotricity\.co\.uk|octopus\.energy|co2counter\.co\.uk)(?:\/[^\s<"]*)?/g;
const linkify = (html: string) => html.replace(LINK_HOSTS, (u) => '<a href="' + u + '" style="color:#3F5B3A;font-weight:bold">' + u.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "") + "</a>");
const htmlFor = (text: string, button?: { label: string; href: string }) =>
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">' +
  text.split(/\n{2,}/).map((p) => "<p>" + linkify(escHtml(p)).replace(/\n/g, "<br>") + "</p>").join("") +
  (button ? '<p><a href="' + escHtml(button.href) + '" style="display:inline-block;padding:10px 18px;background:#3F5B3A;color:#ffffff;text-decoration:none;border-radius:8px">' + escHtml(button.label) + "</a></p>" : "") +
  "</div>";

async function sendEmail(mail: Record<string, unknown>, name = "") {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env("RESEND_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromFor(name), ...mail }),
  });
  if (!res.ok) throw new Error("resend " + res.status + " " + (await res.text()));
}

// The writer's copy goes separately, from plain "CO2 Counter". CC'ing them on
// mail whose From line shows their own name from another domain looks like
// impersonation to Outlook and Gmail, so their copy landed in junk.
async function sendCopy(userEmail: string, sentTo: string, subject: string, text: string, html: string) {
  const note = "Here's a copy of the message CO2 Counter sent for you to " + sentTo + ". Replies will come straight to you.";
  try {
    await sendEmail({
      to: [userEmail], subject: "Your copy: " + subject,
      text: note + "\n\n----------\n\n" + text,
      html: '<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#555;background:#f3efe4;padding:10px 14px;border-radius:8px">' + escHtml(note) + "</p>" + html,
    });
  } catch (e) {
    // The letter itself went; a missing copy shouldn't report a failure.
    console.error("copy failed", e);
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    // Who is sending: the signed-in person's own token.
    const auth = req.headers.get("Authorization") || "";
    const ures = await fetch(env("SUPABASE_URL") + "/auth/v1/user", { headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: auth } });
    if (!ures.ok) return json({ error: "Please sign in again." }, 401);
    const user = await ures.json();
    if (!user || !user.id || !user.email) return json({ error: "Please sign in again." }, 401);

    const body = await req.json();
    const name = clean(body.name, 80);
    const message = clean(body.message, 5000);
    if (name.length < 2) return json({ error: "Please add your name." }, 400);
    if (message.length < 20) return json({ error: "Please write a little more in your message." }, 400);
    if (/\[(Say what|Your )/.test(message)) return json({ error: "Please replace the part in [square brackets] with your own words." }, 400);
    const footer = "\n\n--\nSent with CO2 Counter (" + SITE + ") on behalf of " + name + ". Replies go straight to them.";

    if (body.kind === "mp") {
      const postcode = clean(body.postcode, 10).toUpperCase();
      const address = clean(body.address, 300);
      if (!/^[A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2}$/.test(postcode)) return json({ error: "Please check your postcode." }, 400);
      if (address.length < 5) return json({ error: "Please add your address. MPs only reply to their own constituents." }, 400);
      if (await sentSince(user.id, "mp", 7 * 86400000)) return json({ error: "You've already sent a letter to your MP this week." }, 429);
      const mp = await findMp(postcode);
      if (!mp) return json({ error: "We couldn't find an MP for that postcode." }, 400);
      const letter = message + "\n\n" + name + "\n" + address + "\n" + postcode + footer;
      const mpSubject = "Climate action: a letter from a constituent";
      await sendEmail({
        to: [mp.email], reply_to: user.email,
        subject: mpSubject,
        text: letter, html: htmlFor(letter),
      }, name);
      await sendCopy(user.email, mp.name, mpSubject, letter, htmlFor(letter));
      await db("letters_sent", { method: "POST", body: JSON.stringify({ user_id: user.id, kind: "mp" }) });
      // Sent through us, so Act 6 is verified.
      await db("act_verifications", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ user_id: user.id, act: "mobilise" }) });
      return json({ ok: true, to: mp.name });
    }

    if (body.kind === "energy") {
      const to = clean(body.to, 200).toLowerCase();
      if (!EMAIL.test(to)) return json({ error: "Please check their email address." }, 400);
      if (to === String(user.email).toLowerCase()) return json({ error: "That's your own email address." }, 400);
      if ((await sentSince(user.id, "energy", 86400000)) >= 3) return json({ error: "You've sent three of these today. Try again tomorrow." }, 429);
      const token = await energyToken(user.id);
      const link = SITE + "#/confirm/energy?t=" + token;
      const first = name.split(/\s+/)[0];
      const subject = first + ": could we switch to renewable electricity?";
      const text = message + "\n\nOnce we've switched, please tap this link to let " + name + " know (no account needed):\n" + link + footer;
      const html = htmlFor(message + "\n\nOnce we've switched, tap the button to let " + name + " know. No account needed.", { label: "Yes, we've switched", href: link }) +
        '<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#777">' + escHtml(footer.replace(/^\s*--\s*/, "")) + "</p>";
      await sendEmail({ to: [to], reply_to: user.email, subject, text, html }, name);
      await sendCopy(user.email, to, subject, text, html);
      await db("letters_sent", { method: "POST", body: JSON.stringify({ user_id: user.id, kind: "energy" }) });
      return json({ ok: true });
    }
    return json({ error: "Unknown letter type." }, 400);
  } catch (e) {
    console.error(e);
    // The reason, for the site's admin to see (no personal data in it).
    const detail = String((e && (e as Error).message) || e).slice(0, 300);
    return json({ error: "Couldn't send just now. Please try again, or use your own email app.", detail }, 500);
  }
}

if ((globalThis as any).Deno && (globalThis as any).Deno.serve) (globalThis as any).Deno.serve(handler);
