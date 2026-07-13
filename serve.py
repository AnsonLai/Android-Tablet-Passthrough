#!/usr/bin/env python3
"""Threaded, no-cache static server for local/LAN testing of the docs/ PWA.

The stdlib `python -m http.server` is single-threaded: one hung keep-alive
socket (browsers open several) wedges the whole server. This uses
ThreadingHTTPServer so that can't happen, and sends no-store headers so the
browser's HTTP cache never serves stale JS while you're iterating.

    python serve.py            # serves docs/ on http://0.0.0.0:8123
    python serve.py 9000       # custom port

For your tablet, browse to http://<this-machine-LAN-IP>:8123/ .
Note: the service worker still caches the app shell (that's the point of the
PWA). If a code change doesn't show up, use the in-app "reset" isn't enough —
do a hard refresh, or bump CACHE in docs/sw.js on real deploys.
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Serving {ROOT} at http://0.0.0.0:{PORT}/ (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
