import hashlib
import hmac
import os
import random
import secrets
import uuid

import argon2
import bcrypt
import jwt
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import dh, dsa, ec, padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from Crypto.Cipher import AES
from Crypto.PublicKey import DSA, RSA
from Crypto.Signature import pkcs1_15
from Crypto.Hash import SHA1, SHA256


def key_sizes():
    # ruleid: jgates.python.weak-key-size
    rsa.generate_private_key(public_exponent=65537, key_size=1024)
    # ruleid: jgates.python.weak-key-size
    RSA.generate(1024)
    # ruleid: jgates.python.weak-key-size
    dsa.generate_private_key(key_size=1024)
    # ruleid: jgates.python.weak-key-size
    ec.generate_private_key(ec.SECP192R1())
    # ok: jgates.python.weak-key-size
    rsa.generate_private_key(public_exponent=65537, key_size=3072)
    # ok: jgates.python.weak-key-size
    ec.generate_private_key(ec.SECP256R1())
    # ok: jgates.python.weak-key-size
    RSA.generate(4096)


def rsa_below_3072():
    # ruleid: jgates.python.rsa-key-below-3072
    rsa.generate_private_key(public_exponent=65537, key_size=2048)
    # ruleid: jgates.python.rsa-key-below-3072
    RSA.generate(2048)
    # ok: jgates.python.rsa-key-below-3072
    rsa.generate_private_key(public_exponent=65537, key_size=3072)
    # ok: jgates.python.rsa-key-below-3072
    RSA.generate(4096)


def static_iv(key, data):
    # ruleid: jgates.python.static-iv-or-nonce
    Cipher(algorithms.AES(key), modes.GCM(b"0123456789ab"))
    # ruleid: jgates.python.static-iv-or-nonce
    Cipher(algorithms.AES(key), modes.GCM(bytes(12)))
    # ruleid: jgates.python.static-iv-or-nonce
    AES.new(key, AES.MODE_GCM, nonce=b"000000000000")
    # ruleid: jgates.python.static-iv-or-nonce
    AESGCM(key).encrypt(b"\x00" * 12, data, None)
    # ok: jgates.python.static-iv-or-nonce
    Cipher(algorithms.AES(key), modes.GCM(os.urandom(12)))
    # ok: jgates.python.static-iv-or-nonce
    AES.new(key, AES.MODE_GCM)
    # ok: jgates.python.static-iv-or-nonce
    AESGCM(key).encrypt(os.urandom(12), data, None)


def unauthenticated_modes(key, iv):
    # ruleid: jgates.python.cipher-mode-without-authentication
    Cipher(algorithms.AES(key), modes.CBC(iv))
    # ruleid: jgates.python.cipher-mode-without-authentication
    AES.new(key, AES.MODE_CTR)
    # ok: jgates.python.cipher-mode-without-authentication
    Cipher(algorithms.AES(key), modes.GCM(iv))
    # ok: jgates.python.cipher-mode-without-authentication
    AES.new(key, AES.MODE_GCM)


def weak_modes(key, public_key, data):
    # ruleid: jgates.python.weak-cipher-mode
    Cipher(algorithms.AES(key), modes.ECB())
    # ruleid: jgates.python.weak-cipher-mode
    AES.new(key, AES.MODE_ECB)
    # ruleid: jgates.python.weak-cipher-mode
    public_key.encrypt(data, padding.PKCS1v15())
    # ok: jgates.python.weak-cipher-mode
    public_key.encrypt(
        data,
        padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )
    # ok: jgates.python.weak-cipher-mode
    AES.new(key, AES.MODE_GCM)


def kdf_parameters(password, salt):
    # ruleid: jgates.python.weak-kdf-parameters
    hashlib.pbkdf2_hmac("sha256", password, salt, 1000)
    # ruleid: jgates.python.weak-kdf-parameters
    PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=10000)
    # ruleid: jgates.python.weak-kdf-parameters
    bcrypt.gensalt(rounds=4)
    # ruleid: jgates.python.weak-kdf-parameters
    Scrypt(salt=salt, length=32, n=1024, r=8, p=1)
    # ruleid: jgates.python.weak-kdf-parameters
    argon2.PasswordHasher(time_cost=1)
    # ruleid: jgates.python.weak-kdf-parameters
    argon2.PasswordHasher(memory_cost=1024)
    # ok: jgates.python.weak-kdf-parameters
    hashlib.pbkdf2_hmac("sha256", password, salt, 600000)
    # ok: jgates.python.weak-kdf-parameters
    PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=600000)
    # ok: jgates.python.weak-kdf-parameters
    bcrypt.gensalt(rounds=12)
    # ok: jgates.python.weak-kdf-parameters
    Scrypt(salt=salt, length=32, n=2**15, r=8, p=1)
    # ok: jgates.python.weak-kdf-parameters
    argon2.PasswordHasher(time_cost=3, memory_cost=65536)


def password_hashing(password, user):
    # ruleid: jgates.python.password-hash-with-fast-hash
    hashlib.sha256(password.encode())
    # ruleid: jgates.python.password-hash-with-fast-hash
    hashlib.sha512(user.password)
    # ruleid: jgates.python.password-hash-with-fast-hash
    hashlib.sha256((user.salt + password).encode())
    # ok: jgates.python.password-hash-with-fast-hash
    bcrypt.hashpw(password.encode(), bcrypt.gensalt())
    # ok: jgates.python.password-hash-with-fast-hash
    hashlib.sha256(user.name.encode())
    # ok: jgates.python.password-hash-with-fast-hash
    hashlib.pbkdf2_hmac("sha256", password.encode(), user.salt, 600000)


def comparisons(key, message, received_signature, expected_mac, received_mac):
    # ruleid: jgates.python.timing-unsafe-comparison
    hmac.new(key, message, "sha256").hexdigest() == received_signature
    # ruleid: jgates.python.timing-unsafe-comparison
    if expected_mac != received_mac:
        return False
    # ruleid: jgates.python.timing-unsafe-comparison
    received_signature == expected_mac
    # ok: jgates.python.timing-unsafe-comparison
    hmac.compare_digest(hmac.new(key, message, "sha256").hexdigest(), received_signature)
    # ok: jgates.python.timing-unsafe-comparison
    if received_signature is None:
        return False
    # ok: jgates.python.timing-unsafe-comparison
    if received_mac == "":
        return False


def signature_hashes(key, private_key, data, signature):
    # ruleid: jgates.python.weak-signature-hash
    hmac.new(key, data, hashlib.sha1)
    # ruleid: jgates.python.weak-signature-hash
    private_key.sign(data, padding.PKCS1v15(), hashes.SHA1())
    # ruleid: jgates.python.weak-signature-hash
    pkcs1_15.new(private_key).sign(SHA1.new(data))
    # ruleid: jgates.python.weak-signature-hash
    hmac.new(key, data, digestmod="md5")
    # ok: jgates.python.weak-signature-hash
    hmac.new(key, data, hashlib.sha256)
    # ok: jgates.python.weak-signature-hash
    private_key.sign(data, padding.PKCS1v15(), hashes.SHA256())
    # ok: jgates.python.weak-signature-hash
    pkcs1_15.new(private_key).sign(SHA256.new(data))


def dh_parameters():
    # ruleid: jgates.python.weak-dh-parameters
    dh.generate_parameters(generator=2, key_size=1024)
    # ruleid: jgates.python.weak-dh-parameters
    dh.generate_parameters(2, 512)
    # ok: jgates.python.weak-dh-parameters
    dh.generate_parameters(generator=2, key_size=2048)
    # ok: jgates.python.weak-dh-parameters
    dh.generate_parameters(2, 3072)


def hardcoded_keys(token, payload, data):
    # ruleid: jgates.python.hardcoded-encryption-key
    AES.new(b"0123456789abcdef", AES.MODE_GCM)
    # ruleid: jgates.python.hardcoded-encryption-key
    Fernet("bG9uZy1saXRlcmFsLWtleS1ub3QtYS1zZWNyZXQtYW55bW9yZQ==")
    # ruleid: jgates.python.hardcoded-encryption-key
    hmac.new(b"shared-secret", data, "sha256")
    # ruleid: jgates.python.hardcoded-encryption-key
    jwt.encode(payload, "my-signing-secret", algorithm="HS256")
    # ok: jgates.python.hardcoded-encryption-key
    AES.new(os.environ["APP_KEY"].encode(), AES.MODE_GCM)
    # ok: jgates.python.hardcoded-encryption-key
    Fernet(Fernet.generate_key())
    # ok: jgates.python.hardcoded-encryption-key
    jwt.encode(payload, os.environ["JWT_SECRET"], algorithm="HS256")


def random_secrets(chars):
    # ruleid: jgates.python.insecure-random-for-secret
    token = random.getrandbits(128)
    # ruleid: jgates.python.insecure-random-for-secret
    reset_code = "".join(random.choice(chars) for _ in range(6))
    # ruleid: jgates.python.insecure-random-for-secret
    session_id = str(random.randint(0, 10**12))
    # ok: jgates.python.insecure-random-for-secret
    token = secrets.token_urlsafe(32)
    # ok: jgates.python.insecure-random-for-secret
    reset_code = "".join(secrets.choice(chars) for _ in range(6))
    # ok: jgates.python.insecure-random-for-secret
    delay = random.uniform(0.5, 1.5)
    return token, reset_code, session_id, delay


def uuid_secrets():
    # ruleid: jgates.python.uuid-as-secret-token
    reset_token = str(uuid.uuid4())
    # ruleid: jgates.python.uuid-as-secret-token
    api_key = uuid.uuid1().hex
    # ok: jgates.python.uuid-as-secret-token
    request_id = str(uuid.uuid4())
    # ok: jgates.python.uuid-as-secret-token
    session_token = secrets.token_urlsafe(32)
    return reset_token, api_key, request_id, session_token
