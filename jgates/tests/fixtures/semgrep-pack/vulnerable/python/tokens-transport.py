import ssl
import urllib.request
from urllib.parse import urlencode

import jwt
import requests
from OpenSSL import SSL

AUDIENCE = "orders-api"


def read_claims(token, key):
    header = jwt.get_unverified_header(token)
    return jwt.decode(token, key, algorithms=[header["alg"]], audience=AUDIENCE)


def fetch_signing_key(token):
    header = jwt.get_unverified_header(token)
    return requests.get(header["jku"], timeout=10).json()


def read_expired(token, key):
    return jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE, options={"verify_exp": False})


def read_any_audience(token, key):
    return jwt.decode(token, key, algorithms=["RS256"], options={"verify_aud": False})


def read_without_expected_audience(token, key):
    return jwt.decode(token, key, algorithms=["RS256"])


def login_url(client_id, redirect):
    return f"https://idp.example/authorize?response_type=code&client_id={client_id}&redirect_uri={redirect}"


def old_context():
    return ssl.SSLContext(ssl.PROTOCOL_TLSv1)


def weak_ciphers(ctx):
    ctx.set_ciphers("ALL:RC4-SHA")


def download_report():
    return urllib.request.urlopen("http://reports.example.com/daily.csv", timeout=10).read()


def mtls_server():
    ctx = SSL.Context(SSL.TLS_SERVER_METHOD)
    ctx.set_verify(SSL.VERIFY_PEER, lambda *args: True)
    return ctx
