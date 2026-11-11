"""The integration test of V2-47: reaches the db service by name, and checks the api's project folder is read-only.

With an argument it also writes what it saw as JSON evidence there (validated against integration.schema.json).
"""
import json
import socket
import sys
import urllib.request

with socket.create_connection(("db", 5432), timeout=10) as conn:
    conn.sendall(b"PING integration\n")
    answer = conn.makefile("r", encoding="utf-8").readline().strip()
print("db answered:", answer)

with urllib.request.urlopen("http://api:8000/app-mount", timeout=10) as response:
    mount = json.load(response)
print("api project folder writable:", mount["writable"])

if len(sys.argv) > 1:
    with open(sys.argv[1], "w", encoding="utf-8") as handle:
        json.dump({"db": answer, "apiWritable": mount["writable"]}, handle)
sys.exit(0 if answer == "PONG PING integration" and not mount["writable"] else 1)
