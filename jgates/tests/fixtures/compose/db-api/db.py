"""A tiny database stand-in for V2-47: answers every line it receives with PONG and the line."""
import socketserver


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline().decode("utf-8", "replace").strip()
        self.wfile.write(f"PONG {line}\n".encode("utf-8"))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", 5432), Handler) as server:
        server.serve_forever()
