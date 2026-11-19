import subprocess
from email.message import EmailMessage

import ldap3
from flask import Flask, render_template_string, request
from ldap3.utils.conv import escape_filter_chars
from lxml import etree

app = Flask(__name__)


@app.route("/directory")
def directory(conn):
    name = request.args.get("name")
    conn.search("dc=example,dc=org", "(uid=" + escape_filter_chars(name) + ")")
    return "ok"


@app.route("/catalog")
def catalog(tree):
    name = request.args.get("name")
    return str(tree.xpath("//item[@name=$n]", n=name))


@app.route("/banner")
def banner():
    text = request.args.get("text")
    return render_template_string("<h1>{{ text }}</h1>", text=text)


def parse_feed(payload):
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    return etree.fromstring(payload, parser)


@app.route("/transform", methods=["POST"])
def transform():
    stylesheet = etree.XSLT(etree.parse("report.xsl"))
    return str(stylesheet(etree.fromstring(request.data)))


def render_pdf(job):
    subprocess.run(["pdflatex", "-no-shell-escape", job])


@app.route("/contact", methods=["POST"])
def contact():
    msg = EmailMessage()
    msg.set_content("Thanks for writing")
    msg["Subject"] = request.form["subject"]
    return msg.as_string()
