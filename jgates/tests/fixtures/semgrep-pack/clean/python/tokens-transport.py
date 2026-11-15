import secrets
import ssl
import urllib.request
from urllib.parse import urlencode

import jwt
import requests
from OpenSSL import SSL

AUDIENCE = "orders-api"
JWKS_URL = "https://idp.example/.well-known/jwks.json"


def read_claims(token, key):
    return jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE)


def fetch_signing_key(token):
    return requests.get(JWKS_URL, timeout=10).json()


def read_expired(token, key):
    return jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE, options={"verify_exp": True})


def read_any_audience(token, key):
    return jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE)


def login_url(client_id, redirect):
    state = secrets.token_urlsafe(32)
    return f"https://idp.example/authorize?response_type=code&client_id={client_id}&redirect_uri={redirect}&state={state}"


def old_context():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


def weak_ciphers(ctx):
    ctx.set_ciphers("ECDHE+AESGCM:ECDHE+CHACHA20:!aNULL:!eNULL:!RC4:!3DES")


def download_report():
    return urllib.request.urlopen("https://reports.example.com/daily.csv", timeout=10).read()


def mtls_server():
    ctx = SSL.Context(SSL.TLS_SERVER_METHOD)
    ctx.set_verify(SSL.VERIFY_PEER | SSL.VERIFY_FAIL_IF_NO_PEER_CERT, lambda conn, cert, errno, depth, ok: ok)
    return ctx
