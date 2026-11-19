import base64
import csv
import hashlib
import html
import json
import re
import urllib.parse
from urllib.parse import quote, unquote, urlencode

import markdown2
import mistune
import pylibmc
from flask import request
from markdown_it import MarkdownIt
from pymemcache.client import base


def regex_from_request():
    term = request.args.get("q")
    # ruleid: jgates.python.regex-from-request
    re.compile(term)
    # ruleid: jgates.python.regex-from-request
    re.search("^" + request.form["name"], "text")
    # ruleid: jgates.python.regex-from-request
    re.findall(f"{term}.*", "text")
    # ok: jgates.python.regex-from-request
    re.compile(re.escape(term))
    # ok: jgates.python.regex-from-request
    re.search("^" + re.escape(request.form["name"]), "text")
    # ok: jgates.python.regex-from-request
    re.search("^abc$", term)


def nested_quantifier():
    # ruleid: jgates.python.redos-nested-quantifier
    re.compile(r"(a+)+$")
    # ruleid: jgates.python.redos-nested-quantifier
    re.match(r"^(\w*)*end", "text")
    # ruleid: jgates.python.redos-nested-quantifier
    re.search("(?:[a-z]+\\s*)+$", "text")
    # ok: jgates.python.redos-nested-quantifier
    re.compile(r"(ab)+$")
    # ok: jgates.python.redos-nested-quantifier
    re.compile(r"a+$")
    # ok: jgates.python.redos-nested-quantifier
    re.compile(r"(a|b)+c")
    # ok: jgates.python.redos-nested-quantifier
    re.compile(r"(a\+)+")


def format_string():
    template = request.args.get("fmt")
    # ruleid: jgates.python.format-string-from-request
    template.format(user="x")
    # ruleid: jgates.python.format-string-from-request
    request.form["greeting"].format(user="x")
    # ruleid: jgates.python.format-string-from-request
    template % ("x",)
    # ok: jgates.python.format-string-from-request
    "Hello {}".format(template)
    # ok: jgates.python.format-string-from-request
    "Hello %s" % template
    # ok: jgates.python.format-string-from-request
    "Hello {name}".format(name=template)


def csv_export(out):
    writer = csv.writer(out)
    name = request.form["name"]
    # ruleid: jgates.python.csv-formula-injection
    writer.writerow([name, "x"])
    # ruleid: jgates.python.csv-formula-injection
    writer.writerow([request.args.get("note")])
    # ok: jgates.python.csv-formula-injection
    writer.writerow(["'" + name, "x"])
    # ok: jgates.python.csv-formula-injection
    writer.writerow([name.lstrip("=+-@"), "x"])
    # ok: jgates.python.csv-formula-injection
    writer.writerow(["fixed", "row"])


def memcache_keys():
    client = pylibmc.Client(["127.0.0.1"])
    other = base.Client(("127.0.0.1", 11211))
    user = request.args.get("user")
    # ruleid: jgates.python.memcache-key-from-request
    client.get(user)
    # ruleid: jgates.python.memcache-key-from-request
    other.set("profile:" + user, "v")
    # ok: jgates.python.memcache-key-from-request
    client.get(hashlib.sha256(user.encode()).hexdigest())
    # ok: jgates.python.memcache-key-from-request
    other.set("profile:" + quote(user), "v")
    # ok: jgates.python.memcache-key-from-request
    client.get("fixed-key")


def decoding(value, raw):
    # ruleid: jgates.python.double-decoding
    unquote(unquote(value))
    # ruleid: jgates.python.double-decoding
    base64.b64decode(base64.b64decode(raw))
    # ruleid: jgates.python.double-decoding
    html.unescape(html.unescape(value))
    # ok: jgates.python.double-decoding
    unquote(value)
    # ok: jgates.python.double-decoding
    base64.b64decode(unquote(raw))
    # ok: jgates.python.double-decoding
    html.unescape(unquote(value))


def urls():
    q = request.args.get("q")
    # ruleid: jgates.python.url-parameter-unencoded
    url = "https://api.example.com/search?q=" + q
    # ruleid: jgates.python.url-parameter-unencoded
    url = f"https://api.example.com/items/{request.args['id']}"
    # ruleid: jgates.python.url-parameter-unencoded
    url = "https://api.example.com/search?q=%s" % q
    # ok: jgates.python.url-parameter-unencoded
    url = "https://api.example.com/search?q=" + quote(q)
    # ok: jgates.python.url-parameter-unencoded
    url = "https://api.example.com/search?" + urlencode({"q": q})
    # ok: jgates.python.url-parameter-unencoded
    url = f"https://api.example.com/items/{urllib.parse.quote(q)}"
    return url


def json_text():
    name = request.args.get("name")
    # ruleid: jgates.python.json-built-by-concatenation
    body = '{"name": "' + name + '"}'
    # ruleid: jgates.python.json-built-by-concatenation
    body = '{"name": "%s"}' % name
    # ruleid: jgates.python.json-built-by-concatenation
    body = f'{{"name": "{name}"}}'
    # ok: jgates.python.json-built-by-concatenation
    body = json.dumps({"name": name})
    # ok: jgates.python.json-built-by-concatenation
    body = '{"name": "fixed"}'
    return body


def markdown_setup(text):
    # ruleid: jgates.python.markdown-raw-html-enabled
    MarkdownIt("commonmark", {"html": True})
    # ruleid: jgates.python.markdown-raw-html-enabled
    mistune.create_markdown(escape=False)
    # ruleid: jgates.python.markdown-raw-html-enabled
    markdown2.markdown(text, safe_mode=False)
    # ok: jgates.python.markdown-raw-html-enabled
    MarkdownIt("commonmark", {"html": False})
    # ok: jgates.python.markdown-raw-html-enabled
    mistune.create_markdown(escape=True)
    # ok: jgates.python.markdown-raw-html-enabled
    markdown2.markdown(text, safe_mode="escape")
