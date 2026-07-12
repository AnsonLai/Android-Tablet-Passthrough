# Tablet Passthrough

A tiny personal PWA that shuttles PDF/DOCX files between a Windows desktop and an Android tablet over WebRTC — no cloud storage, no accounts. Drop a file on the desktop, open it in Word/Acrobat/any editor on the tablet, mark it up, and share it straight back to the desktop. See [design-doc.md](design-doc.md) for the full architecture.

Everything lives in [`app/`](app/) — plain HTML/JS, no build step.

## Hosting (one-time)

The app must be served over **HTTPS** (service workers and PWA install require it). The easiest option is GitHub Pages:

1. Push the contents of `app/` to a repo (e.g. as the repo root or a `docs/` folder).
2. Enable GitHub Pages for that repo.
3. Open the published URL on both devices.

Any static host works (Netlify, Cloudflare Pages, etc.). Document data never touches the host — it only serves the app files. The WebRTC handshake uses the free public PeerJS broker; if it ever feels flaky, self-host [peerjs-server](https://github.com/peers/peerjs-server) and add `{ host, port, path }` to the `new Peer(...)` options in `app/js/transfer.js`.

## Setup (one-time)

**Desktop (Windows):**
1. Open the site in Chrome/Edge and choose **Desktop**.
2. Install it as an app (address-bar install icon) or pin the tab. In Chrome, add the site to *Settings → Performance → Memory Saver → Always keep these sites active* so the tab is never discarded.
3. Click **📁 Choose save folder** so returned files auto-save without prompts.

**Tablet (Android):**
1. Scan the QR code on the desktop screen with the camera and open the link (or open the site, choose **Tablet**, and type the code).
2. On the desktop, click **Trust** when prompted. Pairing is done — it never asks again.
3. In Chrome on the tablet, use **⋮ → Add to Home screen → Install** so the app appears in the Android share sheet.

## Daily use

- **Out:** drag a PDF/DOCX onto the desktop app. It queues (survives reboots) and transfers the moment the tablet app is opened. On the tablet, tap **Open in…** and pick Word, Acrobat, or your editor.
- **Back:** in the editing app, tap **Share** and pick **Passthrough**. The file queues and lands in your desktop save folder as soon as the desktop app is reachable, with a `(1)` suffix if the name already exists.

## Notes & limits

- Both devices need to be reachable over WebRTC — same Wi-Fi always works; different networks usually work via STUN but aren't guaranteed (no TURN relay is configured).
- The share sheet ("Open in…") requires one tap — browsers don't allow it to open automatically.
- "Reset pairing" at the bottom of either app un-pairs without deleting queued files.
- Security model: each device only accepts connections from its one paired peer ID. Anyone who learns your peer IDs could attempt to connect, so don't publish them.
