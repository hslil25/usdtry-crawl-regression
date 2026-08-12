#!/usr/bin/env python3
"""Static server for site/ that never lets the browser cache anything.

Plain `python3 -m http.server` sends no cache headers, so browsers happily hold
on to a stale js/app.js after an edit — the page then renders old code with no
error to show for it. Everything here is served no-store.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "site"


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter: errors only
        if not args or not str(args[0]).startswith(("GET", "HEAD")):
            super().log_message(fmt, *args)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    handler = partial(NoCacheHandler, directory=str(ROOT))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as srv:
        print(f"Serving {ROOT} at http://localhost:{port}/  (Ctrl-C to stop)",
              file=sys.stderr)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
