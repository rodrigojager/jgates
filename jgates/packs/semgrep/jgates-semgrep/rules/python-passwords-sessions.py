import re
import hashlib
import bcrypt
import pyotp
from django import forms
from django.contrib.auth.hashers import make_password, check_password
from django.contrib.auth.password_validation import MinimumLengthValidator
from django_otp.plugins.otp_totp.models import TOTPDevice
from pydantic import BaseModel, Field
from rest_framework import serializers
from wtforms import Form, PasswordField, StringField
from wtforms.validators import Length, Regexp


class SignupForm(Form):
    # ruleid: jgates.python.password-min-length-below-8
    password = PasswordField("Password", validators=[Length(min=6)])
    # ruleid: jgates.python.password-min-length-below-8
    passphrase = PasswordField("Passphrase", validators=[Length(min=4, max=200)])
    # ok: jgates.python.password-min-length-below-8
    new_password = PasswordField("Password", validators=[Length(min=8)])
    # ok: jgates.python.password-min-length-below-8
    nickname = StringField("Nickname", validators=[Length(min=2)])
    # ruleid: jgates.python.password-max-length-below-64
    password_max = PasswordField("Password", validators=[Length(max=20)])
    # ruleid: jgates.python.password-max-length-below-64
    password_max_two = PasswordField("Password", validators=[Length(min=8, max=32)])
    # ok: jgates.python.password-max-length-below-64
    password_wide = PasswordField("Password", validators=[Length(min=8, max=128)])
    # ok: jgates.python.password-max-length-below-64
    short_nick = StringField("Nick", validators=[Length(max=20)])
    # ruleid: jgates.python.password-composition-rule
    password_rules = PasswordField("Password", validators=[Regexp(r"^(?=.*[A-Z])(?=.*\d).+$")])
    # ok: jgates.python.password-composition-rule
    password_plain = PasswordField("Password", validators=[Regexp(r"^\S+$")])


class LoginForm(forms.Form):
    # ruleid: jgates.python.password-min-length-below-8
    password = forms.CharField(min_length=4)
    # ruleid: jgates.python.password-max-length-below-64
    password_two = forms.CharField(max_length=16)
    # ok: jgates.python.password-min-length-below-8
    password_ok = forms.CharField(min_length=12)
    # ok: jgates.python.password-max-length-below-64
    username = forms.CharField(max_length=30)


class PasswordPayload(BaseModel):
    # ruleid: jgates.python.password-min-length-below-8
    password: str = Field(..., min_length=5)
    # ruleid: jgates.python.password-max-length-below-64
    senha: str = Field(..., max_length=24)
    # ok: jgates.python.password-min-length-below-8
    password_ok: str = Field(..., min_length=10, max_length=128)
    # ok: jgates.python.password-max-length-below-64
    title: str = Field(..., max_length=24)


class AccountSerializer(serializers.Serializer):
    # ruleid: jgates.python.password-min-length-below-8
    password = serializers.CharField(min_length=3)
    # ok: jgates.python.password-min-length-below-8
    password_two = serializers.CharField(min_length=9)


AUTH_PASSWORD_VALIDATORS = [
    # ruleid: jgates.python.password-min-length-below-8
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 6}},
    # ok: jgates.python.password-min-length-below-8
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 12}},
]
# ruleid: jgates.python.password-min-length-below-8
short_validator = MinimumLengthValidator(min_length=4)
# ok: jgates.python.password-min-length-below-8
long_validator = MinimumLengthValidator(min_length=10)


def composition(password, other):
    # ruleid: jgates.python.password-composition-rule
    re.match(r"(?=.*[a-z])(?=.*[A-Z]).{8,}", password)
    # ruleid: jgates.python.password-composition-rule
    re.search(r"^(?=.*\d)(?=.*[!@#]).+$", password)
    # ok: jgates.python.password-composition-rule
    re.match(r"(?=.*[a-z]).{8,}", other)
    # ok: jgates.python.password-composition-rule
    re.match(r"^\S+$", password)


def transform(password, other):
    # ruleid: jgates.python.password-transformed-before-verify
    bcrypt.hashpw(password.lower().encode(), bcrypt.gensalt())
    # ruleid: jgates.python.password-transformed-before-verify
    make_password(password.upper())
    # ruleid: jgates.python.password-transformed-before-verify
    hashlib.sha256(password[:10].encode())
    # ruleid: jgates.python.password-transformed-before-verify
    check_password(password.lower(), other)
    # ok: jgates.python.password-transformed-before-verify
    bcrypt.hashpw(password.encode(), bcrypt.gensalt())
    # ok: jgates.python.password-transformed-before-verify
    make_password(password)
    # ok: jgates.python.password-transformed-before-verify
    make_password(other.lower())


# ruleid: jgates.python.permit-all-requests
REST_FRAMEWORK = {"DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"]}
# ruleid: jgates.python.permit-all-requests
REST_FRAMEWORK_TWO = {"PAGE_SIZE": 10, "DEFAULT_PERMISSION_CLASSES": ("rest_framework.permissions.AllowAny",)}
# ok: jgates.python.permit-all-requests
REST_FRAMEWORK_SAFE = {"DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"]}
# ok: jgates.python.permit-all-requests
REST_FRAMEWORK_PAGES = {"PAGE_SIZE": 10}


def totp(secret, code, device):
    # ruleid: jgates.python.totp-window-too-wide
    pyotp.TOTP(secret, interval=300)
    # ruleid: jgates.python.totp-window-too-wide
    pyotp.TOTP(secret).verify(code, valid_window=5)
    # ruleid: jgates.python.totp-window-too-wide
    TOTPDevice(user=device, step=120)
    # ruleid: jgates.python.totp-window-too-wide
    TOTPDevice(user=device, tolerance=4)
    # ok: jgates.python.totp-window-too-wide
    pyotp.TOTP(secret, interval=30)
    # ok: jgates.python.totp-window-too-wide
    pyotp.TOTP(secret).verify(code, valid_window=1)
    # ok: jgates.python.totp-window-too-wide
    TOTPDevice(user=device, step=30, tolerance=1)


class Profile:
    # ruleid: jgates.python.secret-question-present
    secret_question = "text"
    # ruleid: jgates.python.secret-question-present
    security_answer: str
    # ok: jgates.python.secret-question-present
    display_name = "text"
    # ok: jgates.python.secret-question-present
    recovery_email: str
