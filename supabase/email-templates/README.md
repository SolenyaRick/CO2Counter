# Auth emails

The emails Supabase sends for sign-up, password resets and account changes.
They share one layout, built by `build.mjs`, in the app's forest-green
chapter look: a canopy band with the big heading and a sprout button, then the
cream card below. Edit `build.mjs`, not the HTML files, then run:

    node supabase/email-templates/build.mjs

## Where each one goes

In the Supabase dashboard, open each setting below, paste the **Subject**, and
paste the whole HTML file into the **Body** (Source) box. Save each one.

| File | Supabase setting | Subject |
|---|---|---|
| `confirm-signup.html` | Authentication → Emails → Templates → Confirm sign up | Confirm your email for CO2 Counter |
| `reset-password.html` | Authentication → Emails → Templates → Reset password | Reset your CO2 Counter password |
| `magic-link.html` | Authentication → Emails → Templates → Magic link | Your CO2 Counter sign-in link |
| `change-email.html` | Authentication → Emails → Templates → Change email address | Confirm your new email for CO2 Counter |
| `reauthentication.html` | Authentication → Emails → Templates → Reauthentication | Your CO2 Counter code: {{ .Token }} |
| `password-changed.html` | Authentication → Emails → Security notifications → Password changed | Your CO2 Counter password has changed |
| `email-changed.html` | Authentication → Emails → Security notifications → Email address changed | Your CO2 Counter email has changed |

The app sends sign-up, reset password, magic link ("Email me a sign-in link"
on the sign-in screen) and change email (the Change button by your email on
Account). Reauthentication is only sent if "Secure password change" is turned
on in Supabase. The two security notices need turning on in the Security
notifications section.

## Links

Links go to `co2counter.co.uk/?token_hash=…&type=…`, not straight to
Supabase. The page then shows a button that uses the one-time code, because
some email providers (Outlook's, for one) open links to scan them, which would
use the code up before the person gets there.

## Sending through Resend

1. In Resend, add and verify the domain `co2counter.co.uk` (Domains → Add
   domain), then add the DNS records it shows (SPF, DKIM and the return-path
   MX) where the domain's DNS lives. Add a DMARC record too, starting with
   `v=DMARC1; p=none;`. Wait until Resend shows the domain as verified.
2. In Resend, create an API key with **Sending access** only.
3. In Supabase, go to Authentication → Emails → SMTP settings, turn on
   **Enable custom SMTP**, and enter:
   - Sender email: `hello@co2counter.co.uk` (any address on the verified domain)
   - Sender name: `CO2 Counter`
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: the Resend API key
4. In Authentication → Rate limits, raise **Rate limit for sending emails**
   (Supabase's built-in sender allows only a couple an hour; with your own
   SMTP you can set it to something like 100 an hour).
5. Sign up with a test address and ask for a password reset to see both
   emails arrive. Check they land in the inbox, not spam, in Gmail and Outlook.
