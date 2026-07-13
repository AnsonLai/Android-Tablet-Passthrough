# TURN credential Worker (Cloudflare)

Cross-network connections (tablet on mobile data ↔ PC on home Wi-Fi) need a
TURN relay. This Worker keeps the Cloudflare TURN API token secret and hands
the page short-lived (24 h) credentials instead. Cloudflare's free tier
includes 1 TB/month of relayed traffic; the relay only carries traffic when a
direct connection is impossible, and data channels stay end-to-end encrypted
either way.

## One-time setup (~15 minutes)

1. **Create a Cloudflare account** (free): <https://dash.cloudflare.com/sign-up>

2. **Create a TURN key**: in the dashboard go to **Realtime → TURN Server**
   (older dashboards label it **Calls**) and click **Create**. Note the two
   values it shows:
   - *Turn Token ID* → this is `TURN_KEY_ID`
   - *API Token* → this is `TURN_API_TOKEN` (shown once — copy it now)

3. **Create the Worker**: go to **Workers & Pages → Create → Worker**, give it
   a name like `atp-turn`, deploy the hello-world, then **Edit code**, replace
   everything with the contents of [`worker.js`](worker.js), and **Deploy**.

4. **Set the variables**: in the Worker's **Settings → Variables and Secrets**
   add:
   | Name | Type | Value |
   |---|---|---|
   | `TURN_KEY_ID` | Text | the Turn Token ID from step 2 |
   | `TURN_API_TOKEN` | **Secret** | the API token from step 2 |
   | `ALLOWED_ORIGINS` | Text | `https://ansonlai.github.io` |

   For local testing, add your dev origin too, comma-separated, e.g.
   `https://ansonlai.github.io,http://localhost:8080`.

5. **Point the app at it**: copy the Worker URL (e.g.
   `https://atp-turn.YOURNAME.workers.dev`) into `TURN_CREDENTIALS_URL` near
   the top of [`docs/js/transfer.js`](../docs/js/transfer.js), then commit and
   push so GitHub Pages redeploys.

## Verifying it works

- Open the Worker URL in a browser tab — you should get a JSON array
  containing `turn.cloudflare.com` entries. (Direct visits have no `Origin`
  header quirk: browsers omit it, so if you set `ALLOWED_ORIGINS` and get
  `origin not allowed`, that's expected — the app itself will still pass.)
- Put the tablet on mobile data, open the app on both devices; they should
  connect within ~15 s. In Chrome, `chrome://webrtc-internals` shows the
  selected candidate pair — type `relay` means the TURN path is in use.

## Notes

- Credentials expire after 24 h; the app refreshes them every 12 h and on
  every restart, so a long-lived relayed session drops at most once a day and
  redials itself within seconds.
- The Worker URL is public. `ALLOWED_ORIGINS` deters casual abuse (browsers
  enforce it), but a non-browser client could still request credentials —
  worst case they consume relay quota against the 1 TB/month free tier. Your
  files are never readable by anyone: DTLS encrypts them end to end.
