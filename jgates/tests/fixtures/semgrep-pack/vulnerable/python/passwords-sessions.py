import re
import bcrypt
import pyotp
from django import forms
from django.contrib.auth.hashers import make_password

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 6}},
]

REST_FRAMEWORK = {"DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"]}


class SignupForm(forms.Form):
    password = forms.CharField(max_length=20)
    nickname = forms.CharField(max_length=30)


def store_password(password):
    return bcrypt.hashpw(password.lower().encode(), bcrypt.gensalt())


def strong_enough(password):
    return re.match(r"(?=.*[A-Z])(?=.*\d).{8,}", password)


def check_code(secret, code):
    return pyotp.TOTP(secret).verify(code, valid_window=6)


class Profile:
    secret_question = "text"
