# Fixture of python-signals.yaml: one match and one non-match per rule. Never run.

# ruleid: jgates.python.uses-graphql
import graphene
# ruleid: jgates.python.uses-graphql
from strawberry.fastapi import GraphQLRouter
# ok: jgates.python.uses-graphql
NOTE_GQL = "import graphene"  # graphene is mentioned in a string only
# ok: jgates.python.uses-graphql
import graphics_helpers

# ruleid: jgates.python.uses-websocket
import websockets
# ruleid: jgates.python.uses-websocket
from fastapi import FastAPI, WebSocket
# ruleid: jgates.python.uses-websocket
from flask_socketio import SocketIO
# ruleid: jgates.python.uses-websocket
ws = web.WebSocketResponse()
# ok: jgates.python.uses-websocket
NOTE_WS = "from websockets import connect"
# ok: jgates.python.uses-websocket
import websocket_notes_parser


# ruleid: jgates.python.uses-websocket
@app.websocket("/live")
async def live(socket):
    pass


# ruleid: jgates.python.uses-webrtc
import aiortc
# ruleid: jgates.python.uses-webrtc
from aiortc.contrib.media import MediaPlayer
# ok: jgates.python.uses-webrtc
NOTE_RTC = "aiortc is not used here"
# ok: jgates.python.uses-webrtc
import webrtc_notes

# ruleid: jgates.python.uses-oauth-client
from authlib.integrations.requests_client import OAuth2Session
# ruleid: jgates.python.uses-oauth-client
from requests_oauthlib import OAuth2Session as Session2
# ok: jgates.python.uses-oauth-client
NOTE_OAUTH = "from requests_oauthlib import OAuth2Session"
# ok: jgates.python.uses-oauth-client
import requests

# ruleid: jgates.python.uses-oauth-authorization-server
from oauth2_provider.models import Application
# ruleid: jgates.python.uses-oauth-authorization-server
from authlib.integrations.flask_oauth2 import AuthorizationServer
# ok: jgates.python.uses-oauth-authorization-server
NOTE_AS = "import oauth2_provider"
# ok: jgates.python.uses-oauth-authorization-server
import oauth_notes

# ruleid: jgates.python.uses-jwt
import jwt
# ruleid: jgates.python.uses-jwt
from jose import jwe
# ok: jgates.python.uses-jwt
NOTE_JWT = "import jwt"
# ok: jgates.python.uses-jwt
import jwtfoo_notes

# ruleid: jgates.python.uses-saml
from onelogin.saml2.auth import OneLogin_Saml2_Auth
# ruleid: jgates.python.uses-saml
import saml2
# ok: jgates.python.uses-saml
NOTE_SAML = "import saml2"
# ok: jgates.python.uses-saml
import samlnotes

# ruleid: jgates.python.uses-totp
import pyotp
# ruleid: jgates.python.uses-totp
from django_otp.plugins.otp_totp.models import TOTPDevice
# ruleid: jgates.python.uses-totp
URI = "otpauth://totp/Example?secret=ABC"
# ok: jgates.python.uses-totp
NOTE_TOTP = "pyotp is a library"
# ok: jgates.python.uses-totp
import pyotpnotes

# ruleid: jgates.python.uses-ldap
import ldap3
# ruleid: jgates.python.uses-ldap
import ldap
# ruleid: jgates.python.uses-ldap
SERVER = "ldaps://directory.example.org"
# ok: jgates.python.uses-ldap
NOTE_LDAP = "import ldap3"
# ok: jgates.python.uses-ldap
import ldapnotes

# ruleid: jgates.python.uses-xml
import xml.etree.ElementTree as ET
# ruleid: jgates.python.uses-xml
from lxml import etree
# ruleid: jgates.python.uses-xml
from xml.dom import minidom
# ok: jgates.python.uses-xml
NOTE_XML = "from lxml import etree"
# ok: jgates.python.uses-xml
import xmlnotes

# ruleid: jgates.python.uses-latex
from pylatex import Document
# ruleid: jgates.python.uses-latex
subprocess.run(["pdflatex", "-interaction=nonstopmode", "report.tex"], check=True)
# ruleid: jgates.python.uses-latex
os.system("xelatex report.tex")
# ok: jgates.python.uses-latex
NOTE_TEX = "from pylatex import Document"
# ok: jgates.python.uses-latex
subprocess.run(["ls", "-l"], check=True)

# ruleid: jgates.python.uses-memcache
import pymemcache
# ruleid: jgates.python.uses-memcache
from pylibmc import Client
# ruleid: jgates.python.uses-memcache
CACHE_BACKEND = "django.core.cache.backends.memcached.PyMemcacheCache"
# ok: jgates.python.uses-memcache
NOTE_MC = "import pymemcache"
# ok: jgates.python.uses-memcache
CACHE_BACKEND_LOCAL = "django.core.cache.backends.locmem.LocMemCache"

# ruleid: jgates.python.uses-mail
import smtplib
# ruleid: jgates.python.uses-mail
from email.mime.text import MIMEText
# ruleid: jgates.python.uses-mail
from django.core.mail import send_mail
# ok: jgates.python.uses-mail
NOTE_MAIL = "import smtplib"
# ok: jgates.python.uses-mail
import emailnotes

# ruleid: jgates.python.uses-templates
import jinja2
# ruleid: jgates.python.uses-templates
from flask import Flask, render_template
# ruleid: jgates.python.uses-templates
from django.shortcuts import render
# ok: jgates.python.uses-templates
NOTE_TPL = "import jinja2"
# ok: jgates.python.uses-templates
import templatenotes

# ruleid: jgates.python.uses-file-upload
from fastapi import File, UploadFile
# ruleid: jgates.python.uses-file-upload
from werkzeug.utils import secure_filename
# ruleid: jgates.python.uses-file-upload
upload = request.files["document"]
# ruleid: jgates.python.uses-file-upload
photo = request.FILES.get("photo")
# ok: jgates.python.uses-file-upload
NOTE_UP = "from fastapi import UploadFile"
# ok: jgates.python.uses-file-upload
posted = request.form["title"]

# ruleid: jgates.python.uses-archives
import zipfile
# ruleid: jgates.python.uses-archives
import tarfile
# ruleid: jgates.python.uses-archives
shutil.unpack_archive("bundle.zip", "out")
# ok: jgates.python.uses-archives
NOTE_ZIP = "import zipfile"
# ok: jgates.python.uses-archives
import zipnotes

# ruleid: jgates.python.uses-browser-dom
from browser import document
# ruleid: jgates.python.uses-browser-dom
from selenium import webdriver
# ruleid: jgates.python.uses-browser-dom
from js import document as dom
# ok: jgates.python.uses-browser-dom
NOTE_DOM = "from browser import document"
# ok: jgates.python.uses-browser-dom
import browsernotes
