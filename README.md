# Tablet Passthrough

A tiny personal PWA that shuttles PDF/DOCX files between a Windows desktop and an Android tablet over WebRTC — no cloud storage, no accounts. Drop a file on the desktop, open it in Word/Acrobat/any editor on the tablet, mark it up, and share it straight back to the desktop. See [design-doc.md](design-doc.md) for the full architecture.

Everything lives in [`docs/`](docs/) — plain HTML/JS, no build step.

## Hosting (one-time)

The app must be served over **HTTPS** (service workers and PWA install require it). The easiest option is GitHub Pages:

1. Push this project to a GitHub repo (the app already lives in `docs/`, which GitHub Pages can serve directly).
2. Enable GitHub Pages for the repo: *Settings → Pages → Deploy from a branch → `main` / `docs`*.
3. Open the published URL on both devices.

Any static host works (Netlify, Cloudflare Pages, etc.). Document data never touches the host — it only serves the app files. The WebRTC handshake uses the free public PeerJS broker; if it ever feels flaky, self-host [peerjs-server](https://github.com/peers/peerjs-server) and add `{ host, port, path }` to the `new Peer(...)` options in `docs/js/transfer.js`.

## Setup (one-time)

**Desktop (Windows):**
1. Open the site in Chrome/Edge and choose **Desktop**.
2. Install it as an app (address-bar install icon) or pin the tab. In Chrome, add the site to *Settings → Performance → Memory Saver → Always keep these sites active* so the tab is never discarded.
3. Click **📁 Choose save folder** so returned files auto-save without prompts.

**Tablet (Android):**
1. Scan the QR code on the desktop screen with the camera and open the link (or open the site, choose **Tablet**, and type the code).
2. **Keep both screens on and the app visible on each** while pairing — Android freezes the app if the tablet screen sleeps, and the desktop must be open and registered. With both awake the connection is near-instant (well under a second); click **Trust** when the desktop prompts. Pairing is done — it never asks again. (If the tablet did sleep, just reopen the app; it resumes the attempt automatically, and you can hit **Cancel** on the pairing screen to back out.)
3. In Chrome on the tablet, use **⋮ → Add to Home screen → Install** so the app appears in the Android share sheet.

## Daily use

- **Out:** drag a PDF/DOCX onto the desktop app. It queues (survives reboots) and transfers the moment the tablet app is opened. The tablet pops up an **Open in…** card the instant it arrives — one tap opens the Android share sheet for Word, Acrobat, or your editor.
- **Back:** in the editing app, tap **Share** and pick **Passthrough**. The file queues and saves automatically on the desktop as soon as it's reachable — into your chosen folder (with a `(1)` suffix on name collisions), or as a regular download if no folder is set.
- **Multiple devices:** click the **status in the top-right** to open the device list (up to 8 paired devices). Click a device to make it the active target, ✎ to rename, ✕ to forget, or **＋ Add / re-pair device** to pair another computer or tablet. Queued files remember which device they're for.
- While the page is visible, the connection is pinged every 30 seconds to keep it alive and reconnect automatically if it drops.

## Notes & limits

- Both devices need to be reachable over WebRTC — same Wi-Fi always works; different networks usually work via STUN but aren't guaranteed (no TURN relay is configured).
- The share sheet ("Open in…") requires one tap — browsers don't allow it to open automatically.
- "Reset pairing" at the bottom of either app un-pairs without deleting queued files.
- Security model: each device only accepts connections from its one paired peer ID. Anyone who learns your peer IDs could attempt to connect, so don't publish them.

## License

[Apache 2.0](LICENSE)
