import hashlib
import jwt
import requests
import ssl
from Crypto.Cipher import AES, ARC4, DES
from django.views.decorators.csrf import csrf_exempt
from flask import request


def hashing(data):
    # ruleid: jgates.python.weak-hash
    hashlib.md5(data)
    # ruleid: jgates.python.weak-hash
    hashlib.sha1(data)
    # ruleid: jgates.python.weak-hash
    hashlib.new("md5", data)
    # ok: jgates.python.weak-hash
    hashlib.sha256(data)


def ciphers(key):
    # ruleid: jgates.python.weak-cipher
    DES.new(key, DES.MODE_ECB)
    # ruleid: jgates.python.weak-cipher
    ARC4.new(key)
    # ok: jgates.python.weak-cipher
    AES.new(key, AES.MODE_GCM)


def tls(url):
    # ruleid: jgates.python.tls-verification-disabled
    requests.get(url, verify=False)
    # ruleid: jgates.python.tls-verification-disabled
    ssl._create_unverified_context()
    # ok: jgates.python.tls-verification-disabled
    requests.get(url, verify=True)
    # ok: jgates.python.tls-verification-disabled
    requests.get(url)


def tokens(token, secret):
    # ruleid: jgates.python.jwt-signature-not-verified
    jwt.decode(token, options={"verify_signature": False})
    # ruleid: jgates.python.jwt-signature-not-verified
    jwt.decode(token, secret, verify=False)
    # ok: jgates.python.jwt-signature-not-verified
    jwt.decode(token, secret, algorithms=["HS256"])


# ruleid: jgates.python.csrf-protection-disabled
@csrf_exempt
def transfer(req):
    return None


# ok: jgates.python.csrf-protection-disabled
def transfer_protected(req):
    return None


def privileges():
    # ruleid: jgates.python.client-controlled-privilege
    if request.args.get("is_admin"):
        return "admin"
    # ok: jgates.python.client-controlled-privilege
    if request.args.get("page"):
        return "page"
    return "user"
