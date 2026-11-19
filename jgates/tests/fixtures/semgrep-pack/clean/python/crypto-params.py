import hashlib
import hmac
import os
import secrets

import bcrypt
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import dh, padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from Crypto.Cipher import AES


def new_signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=3072)


def new_archive_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=4096)


def encrypt_record(key, record):
    cipher = Cipher(algorithms.AES(key), modes.GCM(os.urandom(12)))
    return cipher.encryptor().update(record)


def encrypt_block(key, block):
    return AES.new(key, AES.MODE_GCM).encrypt(block)


def hash_new_password(password):
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12))


def stretch(secret, salt):
    return hashlib.pbkdf2_hmac("sha256", secret, salt, 600000)


def check_webhook(key, body, received_signature):
    expected = hmac.new(key, body, "sha256").hexdigest()
    return hmac.compare_digest(expected, received_signature)


def sign_payload(key, body):
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def new_exchange():
    return dh.generate_parameters(generator=2, key_size=2048)


def seal(body):
    return hmac.new(os.environ["SEAL_KEY"].encode(), body, "sha256").hexdigest()


def new_reset_code(chars):
    reset_code = "".join(secrets.choice(chars) for _ in range(6))
    return reset_code


def new_invite_token():
    invite_token = secrets.token_urlsafe(32)
    return invite_token


def decrypt_legacy(private_key, blob):
    return private_key.decrypt(
        blob,
        padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )


def hash_login(password):
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12))
