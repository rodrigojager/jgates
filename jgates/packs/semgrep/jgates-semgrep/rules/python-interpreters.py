import asyncio
import os
import subprocess
from email.message import EmailMessage
from email.mime.text import MIMEText

import ldap
import ldap3
import lxml.etree
import xml.sax
from flask import request, render_template_string
from jinja2 import Template
from ldap3.utils.conv import escape_filter_chars
from lxml import etree


def ldap_ldap3_filter(conn):
    name = request.args.get("name")
    # ruleid: jgates.python.ldap-injection
    conn.search("dc=example,dc=org", "(uid=" + name + ")")
    # ruleid: jgates.python.ldap-injection
    conn.search("dc=example,dc=org", f"(&(objectClass=person)(cn={name}))")
    # ok: jgates.python.ldap-injection
    conn.search("dc=example,dc=org", "(uid=" + escape_filter_chars(name) + ")")
    # ok: jgates.python.ldap-injection
    conn.search("dc=example,dc=org", "(objectClass=person)")


def ldap_python_ldap(conn):
    uid = request.form["uid"]
    # ruleid: jgates.python.ldap-injection
    conn.search_s("dc=example,dc=org", ldap.SCOPE_SUBTREE, "(uid=%s)" % uid)
    # ruleid: jgates.python.ldap-injection
    conn.search_s("ou=" + uid + ",dc=example,dc=org", ldap.SCOPE_SUBTREE, "(objectClass=*)")
    # ok: jgates.python.ldap-injection
    conn.search_s("dc=example,dc=org", ldap.SCOPE_SUBTREE, "(uid=%s)" % ldap.filter.escape_filter_chars(uid))
    # ok: jgates.python.ldap-injection
    conn.search_s("ou=" + ldap.dn.escape_dn_chars(uid) + ",dc=example,dc=org", ldap.SCOPE_SUBTREE, "(objectClass=*)")


def not_ldap(text):
    import re

    query = request.args.get("q")
    # ok: jgates.python.ldap-injection
    return re.search("a+", query)


def xpath_lxml(tree):
    name = request.args.get("name")
    # ruleid: jgates.python.xpath-injection
    tree.xpath("//user[@name='" + name + "']")
    # ruleid: jgates.python.xpath-injection
    etree.XPath(f"//user[@id='{name}']")
    # ok: jgates.python.xpath-injection
    tree.xpath("//user[@name=$n]", n=name)
    # ok: jgates.python.xpath-injection
    etree.XPath("//user[@id=$i]")


def template_source():
    body = request.args.get("body")
    # ruleid: jgates.python.template-from-request
    render_template_string("<p>" + body + "</p>")
    # ruleid: jgates.python.template-from-request
    Template(body).render()
    # ok: jgates.python.template-from-request
    render_template_string("<p>{{ body }}</p>", body=body)
    # ok: jgates.python.template-from-request
    Template("<p>{{ body }}</p>").render(body=body)


def parsers():
    # ruleid: jgates.python.xml-external-entity
    etree.XMLParser(resolve_entities=True)
    # ruleid: jgates.python.xml-external-entity
    lxml.etree.XMLParser(load_dtd=True, no_network=True)
    sax_parser = xml.sax.make_parser()
    # ruleid: jgates.python.xml-external-entity
    sax_parser.setFeature(xml.sax.handler.feature_external_ges, True)
    # ok: jgates.python.xml-external-entity
    etree.XMLParser(resolve_entities=False, no_network=True)
    # ok: jgates.python.xml-external-entity
    sax_parser.setFeature(xml.sax.handler.feature_external_ges, False)


def stylesheet():
    raw = request.data
    # ruleid: jgates.python.xslt-from-request
    etree.XSLT(etree.fromstring(raw))
    # ruleid: jgates.python.xslt-from-request
    etree.XSLT(etree.XML(request.form.get("xsl")))
    # ok: jgates.python.xslt-from-request
    transform = etree.XSLT(etree.parse("report.xsl"))
    # ok: jgates.python.xslt-from-request
    transform(etree.fromstring(raw))


async def latex(job):
    # ruleid: jgates.python.latex-shell-escape
    subprocess.run(["pdflatex", "-shell-escape", job])
    # ruleid: jgates.python.latex-shell-escape
    os.system("xelatex --shell-escape report.tex")
    # ruleid: jgates.python.latex-shell-escape
    await asyncio.create_subprocess_exec("lualatex", "-enable-write18", job)
    # ok: jgates.python.latex-shell-escape
    subprocess.run(["pdflatex", "-no-shell-escape", job])
    # ok: jgates.python.latex-shell-escape
    subprocess.run(["pdflatex", "-shell-restricted", job])


def mail_legacy():
    subject = request.form["subject"]
    msg = MIMEText("hello")
    # ruleid: jgates.python.mail-header-injection
    msg["Subject"] = subject
    # ruleid: jgates.python.mail-header-injection
    msg.add_header("Reply-To", request.form["reply"])
    # ok: jgates.python.mail-header-injection
    msg["Subject"] = subject.replace("\r", "").replace("\n", "")
    # ok: jgates.python.mail-header-injection
    msg["Subject"] = "Welcome"


def mail_modern():
    modern = EmailMessage()
    # ok: jgates.python.mail-header-injection
    modern["Subject"] = request.form["subject"]
    # ok: jgates.python.mail-header-injection
    modern["To"] = "team@example.org"
