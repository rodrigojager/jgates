"""The application under test of V2-47: a small JSON API that honours openapi.yaml.

At start it tries to write next to its code (/app is the project folder, bind mounted by the compose file); /app-mount
reports whether that worked, so a check can prove JGates mounted the project read-only.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    with open("/app/written-by-api.txt", "w", encoding="utf-8") as handle:
        handle.write("the api wrote to the project folder\n")
    APP_WRITABLE = True
except OSError:
    APP_WRITABLE = False

HOME = b"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>V2-47 api</title></head>
<body><h1>V2-47 api</h1><ul><li><a href="/items">items</a></li><li><a href="/health">health</a></li></ul></body></html>
"""
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "geolocation=()",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "v2-47"
    sys_version = ""

    def send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, status, value):
        self.send(status, json.dumps(value).encode("utf-8"), "application/json")

    def do_GET(self):
        route = self.path.split("?", 1)[0]
        if route == "/":
            self.send(200, HOME, "text/html; charset=utf-8")
        elif route == "/health":
            self.json(200, {"status": "ok"})
        elif route == "/items":
            self.json(200, [{"id": 1, "name": "first"}, {"id": 2, "name": "second"}])
        elif route == "/app-mount":
            self.json(200, {"writable": APP_WRITABLE})
        elif route == "/robots.txt":
            self.send(200, b"User-agent: *\nDisallow:\n", "text/plain; charset=utf-8")
        else:
            self.json(404, {"error": "not found"})

    do_HEAD = do_GET

    def log_message(self, fmt, *args):
        print("api:", fmt % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
