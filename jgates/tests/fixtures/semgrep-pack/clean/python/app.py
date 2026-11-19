import hashlib
import json
import subprocess

from flask import Flask, request

app = Flask(__name__)


@app.route("/lookup")
def lookup(cursor):
    name = request.args.get("name")
    cursor.execute("SELECT * FROM users WHERE name = %s", (name,))
    subprocess.run(["ping", name])
    return hashlib.sha256(name.encode()).hexdigest()


@app.route("/restore", methods=["POST"])
def restore():
    return str(json.loads(request.data))
