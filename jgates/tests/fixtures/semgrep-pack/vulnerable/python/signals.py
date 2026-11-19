"""Service entry points. Never run: the twin only has to parse."""
import subprocess
import xml.etree.ElementTree as ET
import zipfile

import graphene
import jinja2
import jwt
import ldap3
import pyotp
import pymemcache
import saml2
import smtplib
import websockets
import aiortc
from authlib.integrations.requests_client import OAuth2Session
from oauth2_provider.models import Application
from fastapi import UploadFile
from browser import document


def start(request):
    schema = graphene.Schema()
    token = jwt.encode({"sub": "42"}, request.signing_key, algorithm="HS256")
    server = ldap3.Server("directory.example.org")
    code = pyotp.TOTP(request.user_seed).now()
    cache = pymemcache.Client(("localhost", 11211))
    session = OAuth2Session("client-id")
    app = Application()
    mail = smtplib.SMTP("localhost")
    page = jinja2.Template("<p>{{ name }}</p>").render(name="x")
    tree = ET.fromstring("<a/>")
    bundle = zipfile.ZipFile("bundle.zip")
    subprocess.run(["pdflatex", "report.tex"], check=True)
    document["title"].text = "ready"
    return schema, token, server, code, cache, session, app, mail, page, tree, bundle, saml2, websockets, aiortc, UploadFile
