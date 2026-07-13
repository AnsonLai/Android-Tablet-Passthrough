/* Cloudflare Worker: mints short-lived TURN credentials for the app.
   The TURN API token stays server-side; the page only ever sees credentials
   that expire after 24 h. See README.md in this folder for setup.

   Environment variables (set in the Worker's Settings → Variables):
     TURN_KEY_ID      — the TURN key ID from Cloudflare Realtime → TURN Server
     TURN_API_TOKEN   — the matching API token (add as a Secret, not plaintext)
     ALLOWED_ORIGINS  — comma-separated page origins allowed to call this
                        worker, e.g. "https://ansonlai.github.io"
                        (deters casual quota abuse; leave unset to allow any) */

const CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);

    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!originOk) return new Response('origin not allowed', { status: 403, headers: cors });

    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
      }
    );
    if (!res.ok) {
      return new Response('TURN credential API error: ' + res.status, { status: 502, headers: cors });
    }
    const data = await res.json();

    // The client expects a plain RTCIceServer array. Cloudflare returns
    // {iceServers: [...]} (older API versions: a single object) — normalize,
    // and keep a public STUN entry so direct connections are still preferred.
    const cf = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    const servers = [{ urls: 'stun:stun.l.google.com:19302' }, ...cf];

    return new Response(JSON.stringify(servers), {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
