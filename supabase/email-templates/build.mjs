// Builds the Supabase auth email templates from one shared layout, so every
// email has the same forest-green look as the app's chapter headers.
//
//   node supabase/email-templates/build.mjs
//
// Writes one .html file per email next to this script. Paste each file's
// contents into Supabase (see README.md in this folder). The {{ .Something }}
// placeholders are Supabase's own and are filled in when the email is sent.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SITE = "https://co2counter.co.uk";

// Brand colours (style.css / the design system). Email clients can't read
// CSS variables, so they are written out here.
const C = {
  cream: "#EFE9DC",
  surface: "#FFFCF5",
  line: "#E2DBCB",
  ink: "#2E2A22",
  ink2: "#4A453A",
  muted: "#6B6455",
  moss: "#3F5B3A",
  mint: "#E7EDDC",
  canopy: "#17241a",
  onCanopy: "#F1EDE4",
  onCanopyMuted: "#B7C2AE",
  sprout: "#C4E57D",
  honey: "#D9A441",
};
const DISPLAY = "'Bricolage Grotesque', 'Trebuchet MS', 'Segoe UI', Helvetica, Arial, sans-serif";
const BODY = "Karla, 'Segoe UI', Helvetica, Arial, sans-serif";

const link = (type) => `${SITE}/?token_hash={{ .TokenHash }}&amp;type=${type}`;

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" bgcolor="${C.sprout}" style="border-radius:12px;background-color:${C.sprout};">
            <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${href}" style="height:52px;v-text-anchor:middle;width:280px;" arcsize="24%" stroke="f" fillcolor="${C.sprout}"><center style="color:${C.canopy};font-family:Segoe UI,Arial,sans-serif;font-size:16px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
            <!--[if !mso]><!--><a href="${href}" target="_blank" style="display:inline-block;padding:16px 30px;font-family:${BODY};font-size:16px;line-height:20px;font-weight:700;color:${C.canopy};text-decoration:none;border-radius:12px;">${label}&nbsp;&rarr;</a><!--<![endif]-->
          </td>
        </tr></table>`;
}

// A one-time code set like the app's hero numbers.
function code() {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding:14px 26px;border:1px solid #3a4d3a;border-radius:20px;font-family:${DISPLAY};font-size:48px;line-height:56px;font-weight:800;letter-spacing:8px;color:${C.sprout};">{{ .Token }}</td>
        </tr></table>`;
}

function note(title, text) {
  return `<tr><td class="pad" style="padding:28px 40px 0 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.mint};border-radius:16px;">
          <tr><td style="padding:16px 20px;font-family:${BODY};font-size:14px;line-height:21px;color:${C.ink2};">
            <strong style="font-family:${DISPLAY};font-size:15px;color:${C.moss};">${title}</strong><br>${text}
          </td></tr>
        </table>
      </td></tr>`;
}

function copyLink(href) {
  return `<p style="margin:0 0 6px 0;font-family:${BODY};font-size:13px;line-height:20px;color:${C.muted};">Button not working? Copy this link into your browser:</p>
        <p style="margin:0 0 22px 0;font-family:${BODY};font-size:13px;line-height:20px;word-break:break-all;"><a href="${href}" target="_blank" style="color:${C.moss};text-decoration:underline;">${href}</a></p>`;
}

function layout(e) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${e.title}</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&amp;family=Karla:wght@400;700&amp;display=swap" rel="stylesheet">
<!--[if mso]><style>table,td,a,p,h1,center{font-family:Segoe UI,Arial,sans-serif !important;}</style><![endif]-->
<style>
  :root { color-scheme: light only; }
  @media (max-width: 620px) {
    .card { width: 100% !important; border-radius: 20px !important; }
    .pad { padding-left: 24px !important; padding-right: 24px !important; }
    .h1 { font-size: 30px !important; line-height: 34px !important; }
  }
  a { color: ${C.moss}; }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.cream};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${e.preheader}&#8202;&#847;&#8202;&#847;&#8202;&#847;&#8202;&#847;&#8202;&#847;&#8202;&#847;&#8202;&#847;&#8202;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.cream};">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" class="card" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;background-color:${C.surface};border-radius:28px;overflow:hidden;box-shadow:0 1px 2px rgba(46,42,34,0.06),0 8px 24px rgba(46,42,34,0.06);">
      <tr><td class="pad" bgcolor="${C.canopy}" style="background-color:${C.canopy};padding:28px 40px 40px 40px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding-right:12px;"><img src="${SITE}/icons/email-mark.png" width="36" height="36" alt="" style="display:block;border:0;"></td>
          <td style="font-family:${DISPLAY};font-size:19px;line-height:24px;font-weight:800;color:${C.onCanopy};letter-spacing:-0.4px;">CO2 Counter</td>
        </tr></table>
        <p style="margin:40px 0 10px 0;font-family:${BODY};font-size:12px;line-height:16px;letter-spacing:1.6px;text-transform:uppercase;font-weight:700;color:${C.sprout};">${e.eyebrow}</p>
        <h1 class="h1" style="margin:0 0 14px 0;font-family:${DISPLAY};font-size:36px;line-height:40px;font-weight:800;letter-spacing:-1px;color:${C.onCanopy};">${e.heading}</h1>
        <p style="margin:0${e.action ? " 0 28px 0" : ""};font-family:${BODY};font-size:17px;line-height:26px;color:${C.onCanopyMuted};">${e.intro}</p>
        ${e.action || ""}
      </td></tr>
      ${e.note || ""}
      <tr><td class="pad" style="padding:26px 40px 34px 40px;">
        ${e.body || ""}
        <p style="margin:0;${e.body ? `padding-top:20px;border-top:1px solid ${C.line};` : ""}font-family:${BODY};font-size:14px;line-height:21px;color:${C.ink2};">${e.closing}</p>
      </td></tr>
    </table>
    <table role="presentation" class="card" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">
      <tr><td align="center" style="padding:24px 24px 0 24px;font-family:${BODY};font-size:12px;line-height:19px;color:${C.muted};">
        <strong style="font-family:${DISPLAY};color:${C.moss};">CO2 Counter</strong> &middot; Know your footprint, then watch it shrink.<br>
        <a href="${SITE}" style="color:${C.muted};text-decoration:underline;">co2counter.co.uk</a> &middot;
        <a href="mailto:CO2counter@outlook.com" style="color:${C.muted};text-decoration:underline;">CO2counter@outlook.com</a><br>
        This email was sent to ${e.sentTo || "{{ .Email }}"}.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
`;
}

const scanners =
  "Some email providers open links to check them, which can use up a one-time link before you get to it. Tapping the button on our page keeps your link safe.";
const notYou = `If this wasn't you, reset your password straight away from <a href="${SITE}/#/account" style="color:${C.moss};text-decoration:underline;">your account page</a> and email us at <a href="mailto:CO2counter@outlook.com" style="color:${C.moss};text-decoration:underline;">CO2counter@outlook.com</a>.`;

// subject: what goes in Supabase's Subject field. setting: where to paste it.
const EMAILS = [
  {
    file: "confirm-signup.html",
    setting: "Authentication → Emails → Templates → Confirm sign up",
    subject: "Confirm your email for CO2 Counter",
    title: "Confirm your CO2 Counter account",
    preheader: "One tap to finish creating your account and see your full footprint.",
    eyebrow: "Confirm your email",
    heading: "You're one tap away",
    intro: "Thanks for joining CO2 Counter. Confirm your email to finish creating your account, and we'll sign you straight in.",
    action: button(link("signup"), "Confirm my email"),
    note: note("Why a button on our website?", scanners),
    body: copyLink(link("signup")),
    closing: "Didn't sign up? You can ignore this email and no account will be created.",
  },
  {
    file: "reset-password.html",
    setting: "Authentication → Emails → Templates → Reset password",
    subject: "Reset your CO2 Counter password",
    title: "Reset your CO2 Counter password",
    preheader: "Choose a new password. This link works once.",
    eyebrow: "Reset your password",
    heading: "Let's get you back in",
    intro: "Someone asked to reset the password for your CO2 Counter account. Tap below to choose a new one. Your footprint and habits are just as you left them.",
    action: button(link("recovery"), "Choose a new password"),
    note: note("Keep your account safe", "This link works once and expires soon. We'll never ask for your password by email."),
    body: copyLink(link("recovery")),
    closing: "Didn't ask for this? You can ignore this email and your password won't change.",
  },
  {
    file: "magic-link.html",
    setting: "Authentication → Emails → Templates → Magic link",
    subject: "Your CO2 Counter sign-in link",
    title: "Sign in to CO2 Counter",
    preheader: "Tap to sign in. This link works once.",
    eyebrow: "Sign in",
    heading: "Here's your sign-in link",
    intro: "Tap below to sign in to CO2 Counter. No password needed.",
    action: button(link("magiclink"), "Sign me in"),
    note: note("Why a button on our website?", scanners),
    body: copyLink(link("magiclink")),
    closing: "Didn't ask to sign in? You can ignore this email. Nobody can get in without this link.",
  },
  {
    file: "change-email.html",
    setting: "Authentication → Emails → Templates → Change email address",
    subject: "Confirm your new email for CO2 Counter",
    title: "Confirm your new email address",
    preheader: "One tap to move your CO2 Counter account to this address.",
    eyebrow: "Change of email",
    heading: "Confirm your new email",
    intro: "You asked to change the email on your CO2 Counter account from {{ .Email }} to {{ .NewEmail }}. Tap below to confirm.",
    action: button(link("email_change"), "Confirm my new email"),
    note: note("Why a button on our website?", scanners),
    body: copyLink(link("email_change")),
    closing: "Didn't ask for this? You can ignore this email and your address won't change.",
  },
  {
    file: "reauthentication.html",
    setting: "Authentication → Emails → Templates → Reauthentication",
    subject: "Your CO2 Counter code: {{ .Token }}",
    title: "Your CO2 Counter code",
    preheader: "Enter this code to confirm it's you.",
    eyebrow: "Confirm it's you",
    heading: "Your one-time code",
    intro: "Enter this code in CO2 Counter to confirm it's you. It works once and expires soon.",
    action: code(),
    closing: "Didn't ask for a code? You can ignore this email. Nobody can use it without signing in as you.",
  },
  {
    file: "password-changed.html",
    setting: "Authentication → Emails → Security notifications → Password changed",
    subject: "Your CO2 Counter password has changed",
    title: "Your password has changed",
    preheader: "A quick note to say your password was just changed.",
    eyebrow: "Account security",
    heading: "Your password has changed",
    intro: "The password for your CO2 Counter account was just changed. If that was you, there's nothing else to do.",
    closing: notYou,
  },
  {
    file: "email-changed.html",
    setting: "Authentication → Emails → Security notifications → Email address changed",
    subject: "Your CO2 Counter email has changed",
    title: "Your email address has changed",
    preheader: "A quick note to say your account email was just changed.",
    eyebrow: "Account security",
    heading: "Your email has changed",
    intro: "The email for your CO2 Counter account was changed from {{ .OldEmail }} to {{ .Email }}. If that was you, there's nothing else to do.",
    closing: notYou,
    sentTo: "{{ .OldEmail }}",
  },
];

for (const e of EMAILS) writeFileSync(join(here, e.file), layout(e));

const rows = EMAILS.map((e) => `| \`${e.file}\` | ${e.setting} | ${e.subject} |`).join("\n");
writeFileSync(
  join(here, "README.md"),
  `# Auth emails

The emails Supabase sends for sign-up, password resets and account changes.
They share one layout, built by \`build.mjs\`, in the app's forest-green
chapter look: a canopy band with the big heading and a sprout button, then the
cream card below. Edit \`build.mjs\`, not the HTML files, then run:

    node supabase/email-templates/build.mjs

## Where each one goes

In the Supabase dashboard, open each setting below, paste the **Subject**, and
paste the whole HTML file into the **Body** (Source) box. Save each one.

| File | Supabase setting | Subject |
|---|---|---|
${rows}

The app sends sign-up, reset password, magic link ("Email me a sign-in link"
on the sign-in screen) and change email (the Change button by your email on
Account). Reauthentication is only sent if "Secure password change" is turned
on in Supabase. The two security notices need turning on in the Security
notifications section.

## Links

Links go to \`co2counter.co.uk/?token_hash=…&type=…\`, not straight to
Supabase. The page then shows a button that uses the one-time code, because
some email providers (Outlook's, for one) open links to scan them, which would
use the code up before the person gets there.

## Sending through Resend

1. In Resend, add and verify the domain \`co2counter.co.uk\` (Domains → Add
   domain), then add the DNS records it shows (SPF, DKIM and the return-path
   MX) where the domain's DNS lives. Add a DMARC record too, starting with
   \`v=DMARC1; p=none;\`. Wait until Resend shows the domain as verified.
2. In Resend, create an API key with **Sending access** only.
3. In Supabase, go to Authentication → Emails → SMTP settings, turn on
   **Enable custom SMTP**, and enter:
   - Sender email: \`hello@co2counter.co.uk\` (any address on the verified domain)
   - Sender name: \`CO2 Counter\`
   - Host: \`smtp.resend.com\`
   - Port: \`465\`
   - Username: \`resend\`
   - Password: the Resend API key
4. In Authentication → Rate limits, raise **Rate limit for sending emails**
   (Supabase's built-in sender allows only a couple an hour; with your own
   SMTP you can set it to something like 100 an hour).
5. Sign up with a test address and ask for a password reset to see both
   emails arrive. Check they land in the inbox, not spam, in Gmail and Outlook.
`
);

console.log("Wrote " + EMAILS.length + " templates and README.md");
