import subprocess
from email.mime.text import MIMEText

import ldap3
from flask import Flask, render_template_string, request
from lxml import etree

app = Flask(__name__)


@app.route("/directory")
def directory(conn):
    name = request.args.get("name")
    conn.search("dc=example,dc=org", "(uid=" + name + ")")
    return "ok"


@app.route("/catalog")
def catalog(tree):
    name = request.args.get("name")
    return str(tree.xpath("//item[@name='" + name + "']"))


@app.route("/banner")
def banner():
    text = request.args.get("text")
    return render_template_string("<h1>" + text + "</h1>")


def parse_feed(payload):
    parser = etree.XMLParser(resolve_entities=True)
    return etree.fromstring(payload, parser)


@app.route("/transform", methods=["POST"])
def transform():
    stylesheet = etree.XSLT(etree.fromstring(request.data))
    return str(stylesheet(etree.XML("<root/>")))


def render_pdf(job):
    subprocess.run(["pdflatex", "-shell-escape", job])


@app.route("/contact", methods=["POST"])
def contact():
    msg = MIMEText("Thanks for writing")
    msg["Subject"] = request.form["subject"]
    return msg.as_string()
