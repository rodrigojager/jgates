import bcrypt
import pyotp
from django import forms

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 12}},
]

REST_FRAMEWORK = {"DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"]}


class SignupForm(forms.Form):
    password = forms.CharField(min_length=12, max_length=128)
    nickname = forms.CharField(max_length=30)


def store_password(password):
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt())


def check_code(secret, code):
    return pyotp.TOTP(secret).verify(code, valid_window=1)


class Profile:
    recovery_email = "text"
