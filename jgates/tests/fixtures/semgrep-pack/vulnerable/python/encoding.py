import base64
import csv
import json
import re
from urllib.parse import unquote

import markdown2
import pylibmc
from flask import request


def search(text):
    pattern = request.args.get("q")
    return re.findall(pattern, text)


def validate_slug(slug):
    return re.match(r"^(\w+)+$", slug)


def greeting():
    template = request.args.get("fmt")
    return template.format(user="visitor")


def export_rows(out):
    writer = csv.writer(out)
    writer.writerow([request.form["name"], "member"])


def cached_profile():
    client = pylibmc.Client(["127.0.0.1"])
    return client.get(request.args.get("user"))


def read_token(value):
    return base64.b64decode(base64.b64decode(value))


def fetch_url():
    return "https://api.example.com/search?q=" + request.args.get("q")


def build_body():
    name = request.args.get("name")
    return '{"name": "' + name + '"}'


def render(text):
    return markdown2.markdown(text, safe_mode=False)
