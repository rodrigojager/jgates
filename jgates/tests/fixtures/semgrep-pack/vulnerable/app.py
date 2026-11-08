import hashlib
import pickle
import subprocess

from flask import Flask, request

app = Flask(__name__)


@app.route("/lookup")
def lookup(cursor):
    name = request.args.get("name")
    cursor.execute("SELECT * FROM users WHERE name = '" + name + "'")
    subprocess.run("ping " + name, shell=True)
    return hashlib.md5(name.encode()).hexdigest()


@app.route("/restore", methods=["POST"])
def restore():
    return str(pickle.loads(request.data))
