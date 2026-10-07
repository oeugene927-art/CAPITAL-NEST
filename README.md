# Capital Nest M-Pesa setup

This repo snapshot was a static HTML/JavaScript app without an existing Supabase Edge Function project or build pipeline, so the M-Pesa integration was added in the missing Supabase structure directly alongside the existing frontend files.

## Required Supabase Dashboard settings

1. Create a Supabase project and enable the Auth feature.
2. In the Supabase Dashboard, go to Settings > API and copy:
   - Project URL
   - service_role secret
3. In Project Settings > Edge Functions, ensure the `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment variables are available to the runtime.
4. Add the M-Pesa credentials as secrets using the Supabase CLI:

```bash
supabase secrets set \
  MPESA_CONSUMER_KEY="..." \
  MPESA_CONSUMER_SECRET="..." \
  MPESA_SHORTCODE="..." \
  MPESA_PASSKEY="..." \
  MPESA_ENV="sandbox" \
  MPESA_SHORTCODE_TYPE="paybill" \
  MPESA_CALLBACK_URL="https://<project-ref>.supabase.co/functions/v1/mpesa-callback" \
  MPESA_CALLBACK_TOKEN="<optional callback token>"
```

5. If you use the callback token for Safaricom callback verification, keep it server-side only. Do not expose it to browsers or log it. It is a shared token and has the usual limitation that anyone with the token can replay a valid callback request.

## Daraja callback configuration

Use the Callback URL in the Daraja app configuration to point at the public callback endpoint:

```text
https://<project-ref>.supabase.co/functions/v1/mpesa-callback
```

The callback endpoint has JWT verification disabled so Safaricom can reach it without a browser session. Callback authentication is validated using the Daraja callback token if configured through `MPESA_CALLBACK_TOKEN`.

## Invoke the authenticated STK function from the app

The frontend can call the function with a signed-in Supabase JWT in the Authorization header. Example:

```javascript
const { data: { session } } = await supabase.auth.getSession();

const response = await fetch(
  'https://<project-ref>.supabase.co/functions/v1/mpesa-stk',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({
      sale_id: '00000000-0000-0000-0000-000000000000',
      phone_number: '254712345678'
    })
  }
);

const result = await response.json();
console.log(result);
```

Never send the `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`, or callback token from the client. The amount is read from the sale record on the server and never accepted from the browser.

## Local testing

```bash
npm test
```

## Notes

- The repo did not contain an existing Supabase project or migration history for `public.sales` and `public.payments`, so this implementation adds the missing migration and Edge Function structure.
- The current frontend remains intact and the main page is preserved. This adds a minimal server-backed payment flow without replacing the app.
