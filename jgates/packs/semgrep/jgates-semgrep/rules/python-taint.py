import os
import requests
from flask import request, send_file
from werkzeug.utils import secure_filename


def validate_url(url):
    return url


def fetch():
    # ruleid: jgates.python.ssrf
    requests.get(request.args.get("url"))
    target = request.form["callback"]
    # ruleid: jgates.python.ssrf
    requests.post(target, data={})
    # ok: jgates.python.ssrf
    requests.get("https://api.example.com/status")
    # ok: jgates.python.ssrf
    requests.get(validate_url(request.args.get("url")))


def download():
    name = request.args.get("name")
    # ruleid: jgates.python.path-traversal
    send_file(name)
    # ruleid: jgates.python.path-traversal
    open(request.args["path"])
    # ok: jgates.python.path-traversal
    send_file(os.path.basename(name))
    # ok: jgates.python.path-traversal
    open(secure_filename(request.args["path"]))
    # ok: jgates.python.path-traversal
    open("static/readme.txt")
