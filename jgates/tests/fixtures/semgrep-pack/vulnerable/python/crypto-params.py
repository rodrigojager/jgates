import hashlib
import hmac
import os
import random
import uuid

import bcrypt
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import dh, padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from Crypto.Cipher import AES


def new_signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=1024)


def new_archive_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def encrypt_record(key, record):
    cipher = Cipher(algorithms.AES(key), modes.GCM(b"0123456789ab"))
    return cipher.encryptor().update(record)


def encrypt_chunk(key, chunk):
    cipher = Cipher(algorithms.AES(key), modes.CBC(os.urandom(16)))
    return cipher.encryptor().update(chunk)


def encrypt_block(key, block):
    return AES.new(key, AES.MODE_ECB).encrypt(block)


def hash_new_password(password):
    return hashlib.sha256(password.encode()).hexdigest()


def stretch(secret, salt):
    return hashlib.pbkdf2_hmac("sha256", secret, salt, 1000)


def check_webhook(key, body, received_signature):
    return hmac.new(key, body, "sha256").hexdigest() == received_signature


def sign_payload(key, body):
    return hmac.new(key, body, hashlib.sha1).hexdigest()


def new_exchange():
    return dh.generate_parameters(generator=2, key_size=1024)


def seal(body):
    return hmac.new(b"shared-secret-value", body, "sha256").hexdigest()


def new_reset_code(chars):
    reset_code = "".join(random.choice(chars) for _ in range(6))
    return reset_code


def new_invite_token():
    invite_token = str(uuid.uuid4())
    return invite_token


def decrypt_legacy(private_key, blob):
    return private_key.decrypt(blob, padding.PKCS1v15())


def hash_login(password):
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=4))
