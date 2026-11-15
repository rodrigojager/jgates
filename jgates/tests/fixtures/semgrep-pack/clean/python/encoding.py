import base64
import csv
import hashlib
import json
import re
from urllib.parse import quote

import markdown2
import pylibmc
from flask import request


def search(text):
    pattern = request.args.get("q")
    return re.findall(re.escape(pattern), text)


def validate_slug(slug):
    return re.match(r"^\w+$", slug)


def greeting():
    template = request.args.get("fmt")
    return "Hello {user}, {fmt}".format(user="visitor", fmt=template)


def export_rows(out):
    writer = csv.writer(out)
    writer.writerow(["'" + request.form["name"], "member"])


def cached_profile():
    client = pylibmc.Client(["127.0.0.1"])
    user = request.args.get("user")
    return client.get(hashlib.sha256(user.encode()).hexdigest())


def read_token(value):
    return base64.b64decode(value)


def fetch_url():
    return "https://api.example.com/search?q=" + quote(request.args.get("q"))


def build_body():
    name = request.args.get("name")
    return json.dumps({"name": name})


def render(text):
    return markdown2.markdown(text, safe_mode="escape")
