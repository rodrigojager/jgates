import ssl
import urllib.request
from urllib.parse import urlencode

import httpx
import jwt
import requests
from OpenSSL import SSL
from urllib3.util.ssl_ import create_urllib3_context

AUDIENCE = "orders-api"


def algorithm_choice(token, key):
    # ruleid: jgates.python.jwt-algorithm-not-restricted
    jwt.decode(token, key, algorithms=["none"], audience=AUDIENCE)
    # ruleid: jgates.python.jwt-algorithm-not-restricted
    jwt.decode(token, key, algorithms=["HS256", "None"], audience=AUDIENCE)
    # ruleid: jgates.python.jwt-algorithm-not-restricted
    jwt.decode(token, key, algorithms=[jwt.get_unverified_header(token)["alg"]], audience=AUDIENCE)
    header = jwt.get_unverified_header(token)
    # ruleid: jgates.python.jwt-algorithm-not-restricted
    jwt.decode(token, key, algorithms=[header["alg"]], audience=AUDIENCE)
    # ok: jgates.python.jwt-algorithm-not-restricted
    jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE)
    # ok: jgates.python.jwt-algorithm-not-restricted
    jwt.decode(token, key, algorithms=["ES256", "RS256"], audience=AUDIENCE)
    # ok: jgates.python.jwt-algorithm-not-restricted
    jwt.get_unverified_header(token)["kid"]


def key_lookup(token, jwks_url):
    header = jwt.get_unverified_header(token)
    # ruleid: jgates.python.jwt-key-from-token-header
    requests.get(header["jku"])
    # ruleid: jgates.python.jwt-key-from-token-header
    jwt.PyJWKClient(jwt.get_unverified_header(token).get("x5u"))
    # ok: jgates.python.jwt-key-from-token-header
    requests.get(jwks_url)
    # ok: jgates.python.jwt-key-from-token-header
    jwt.PyJWKClient(jwks_url)


def expiry(token, key):
    # ruleid: jgates.python.jwt-expiry-not-validated
    jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE, options={"verify_exp": False})
    opts = {"verify_exp": False}
    # ruleid: jgates.python.jwt-expiry-not-validated
    jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE, options=opts)
    # ok: jgates.python.jwt-expiry-not-validated
    jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE, options={"verify_exp": True})
    # ok: jgates.python.jwt-expiry-not-validated
    jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE, leeway=10)


def audience(token, key):
    # ruleid: jgates.python.jwt-audience-not-validated
    jwt.decode(token, key, algorithms=["RS256"], options={"verify_aud": False})
    # ruleid: jgates.python.jwt-audience-not-validated
    jwt.decode(token, key, algorithms=["RS256"])
    # ok: jgates.python.jwt-audience-not-validated
    jwt.decode(token, key, algorithms=["RS256"], audience=AUDIENCE)
    # ok: jgates.python.jwt-audience-not-validated
    jwt.decode(token, key, algorithms=["RS256"], audience=["orders-api", "billing-api"])


def authorize(client_id, redirect, state):
    # ruleid: jgates.python.oauth-request-without-state
    url = f"https://idp.example/authorize?response_type=code&client_id={client_id}&redirect_uri={redirect}"
    # ruleid: jgates.python.oauth-request-without-state
    url2 = "https://idp.example/authorize?" + urlencode({"response_type": "code", "client_id": client_id})
    # ok: jgates.python.oauth-request-without-state
    url3 = f"https://idp.example/authorize?response_type=code&client_id={client_id}&state={state}"
    # ok: jgates.python.oauth-request-without-state
    url4 = "https://idp.example/authorize?" + urlencode({"response_type": "code", "client_id": client_id, "code_challenge": state})
    return url, url2, url3, url4


def tls_versions():
    # ruleid: jgates.python.tls-old-protocol-version
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLSv1)
    # ruleid: jgates.python.tls-old-protocol-version
    ctx.minimum_version = ssl.TLSVersion.TLSv1_1
    # ruleid: jgates.python.tls-old-protocol-version
    legacy = SSL.Context(SSL.SSLv3_METHOD)
    # ok: jgates.python.tls-old-protocol-version
    modern = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # ok: jgates.python.tls-old-protocol-version
    modern.minimum_version = ssl.TLSVersion.TLSv1_2
    # ok: jgates.python.tls-old-protocol-version
    modern.options |= ssl.OP_NO_TLSv1
    return ctx, legacy, modern


def ciphers(ctx):
    # ruleid: jgates.python.tls-weak-cipher-suite
    ctx.set_ciphers("ALL:RC4-SHA")
    # ruleid: jgates.python.tls-weak-cipher-suite
    create_urllib3_context(ciphers="HIGH:EXPORT:ECDHE-RSA-DES-CBC3-SHA")
    # ok: jgates.python.tls-weak-cipher-suite
    ctx.set_ciphers("ECDHE+AESGCM:ECDHE+CHACHA20:!aNULL:!eNULL:!RC4:!3DES")
    # ok: jgates.python.tls-weak-cipher-suite
    create_urllib3_context(ciphers="ECDHE-ECDSA-AES256-GCM-SHA384")


def clients():
    # ruleid: jgates.python.cleartext-http-url
    requests.get("http://api.example.com/orders")
    # ruleid: jgates.python.cleartext-http-url
    urllib.request.urlopen("ftp://files.example.com/report.csv")
    # ruleid: jgates.python.cleartext-http-url
    httpx.post("http://billing.example.com/charge", json={})
    # ok: jgates.python.cleartext-http-url
    requests.get("https://api.example.com/orders")
    # ok: jgates.python.cleartext-http-url
    requests.get("http://localhost:8080/health")
    # ok: jgates.python.cleartext-http-url
    urllib.request.urlopen("http://127.0.0.1:9000/ping")


def mtls_server(cert_ok):
    ctx = SSL.Context(SSL.TLS_SERVER_METHOD)
    # ruleid: jgates.python.mtls-client-certificate-not-verified
    ctx.set_verify(SSL.VERIFY_PEER, lambda *args: True)
    # ruleid: jgates.python.mtls-client-certificate-not-verified
    ctx.set_verify(SSL.VERIFY_PEER | SSL.VERIFY_FAIL_IF_NO_PEER_CERT, lambda conn, cert, errno, depth, ok: True)
    # ok: jgates.python.mtls-client-certificate-not-verified
    ctx.set_verify(SSL.VERIFY_PEER | SSL.VERIFY_FAIL_IF_NO_PEER_CERT, lambda conn, cert, errno, depth, ok: ok)
    # ok: jgates.python.mtls-client-certificate-not-verified
    ctx.set_verify(SSL.VERIFY_PEER, cert_ok)
