import re
from urllib.parse import urlencode

import requests
from django.http import HttpResponse
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from flask import Flask, make_response, request
from flask_cors import CORS, cross_origin

app = Flask(__name__)
api = FastAPI()
ALLOWED = {"https://app.example.com"}


def secure_cookies(resp):
    # ruleid: jgates.python.cookie-without-secure
    resp.set_cookie("__Host-sid", "v", httponly=True, samesite="Lax")
    # ruleid: jgates.python.cookie-without-secure
    resp.set_cookie("__Host-sid", "v", secure=False, httponly=True, samesite="Lax")
    # ruleid: jgates.python.cookie-without-secure
    app.config["SESSION_COOKIE_SECURE"] = False
    # ruleid: jgates.python.cookie-without-secure
    SESSION_COOKIE_SECURE = False
    # ok: jgates.python.cookie-without-secure
    resp.set_cookie("__Host-sid", "v", secure=True, httponly=True, samesite="Lax")
    # ok: jgates.python.cookie-without-secure
    app.config["SESSION_COOKIE_SECURE"] = True


def httponly_cookies(resp):
    # ruleid: jgates.python.cookie-without-httponly
    resp.set_cookie("__Host-sid", "v", secure=True, samesite="Lax")
    # ruleid: jgates.python.cookie-without-httponly
    resp.set_cookie("__Host-sid", "v", secure=True, httponly=False, samesite="Lax")
    # ruleid: jgates.python.cookie-without-httponly
    SESSION_COOKIE_HTTPONLY = False
    # ok: jgates.python.cookie-without-httponly
    resp.set_cookie("__Host-sid", "v", secure=True, httponly=True, samesite="Lax")
    # ok: jgates.python.cookie-without-httponly
    SESSION_COOKIE_HTTPONLY = True


def samesite_cookies(resp):
    # ruleid: jgates.python.cookie-without-samesite
    resp.set_cookie("__Host-sid", "v", secure=True, httponly=True)
    # ruleid: jgates.python.cookie-without-samesite
    resp.set_cookie("__Host-sid", "v", secure=True, httponly=True, samesite="None")
    # ruleid: jgates.python.cookie-without-samesite
    SESSION_COOKIE_SAMESITE = None
    # ok: jgates.python.cookie-without-samesite
    resp.set_cookie("__Host-sid", "v", secure=True, httponly=True, samesite="Strict")
    # ok: jgates.python.cookie-without-samesite
    SESSION_COOKIE_SAMESITE = "Lax"


def cookie_names(resp):
    # ruleid: jgates.python.cookie-name-without-prefix
    resp.set_cookie("sid", "v", secure=True, httponly=True, samesite="Lax")
    # ruleid: jgates.python.cookie-name-without-prefix
    resp.set_cookie(key="session", value="v", secure=True, httponly=True, samesite="Lax")
    # ok: jgates.python.cookie-name-without-prefix
    resp.set_cookie("__Host-sid", "v", secure=True, httponly=True, samesite="Lax")
    # ok: jgates.python.cookie-name-without-prefix
    resp.set_cookie("__Secure-theme", "dark", secure=True, httponly=True, samesite="Lax")


# ruleid: jgates.python.cors-any-origin-with-credentials
CORS(app, supports_credentials=True)
# ruleid: jgates.python.cors-any-origin-with-credentials
CORS(app, supports_credentials=True, origins="*")
# ruleid: jgates.python.cors-any-origin-with-credentials
api.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True)
# ok: jgates.python.cors-any-origin-with-credentials
CORS(app, supports_credentials=True, origins=["https://app.example.com"])
# ok: jgates.python.cors-any-origin-with-credentials
api.add_middleware(CORSMiddleware, allow_origins=["https://app.example.com"], allow_credentials=True)
# ok: jgates.python.cors-any-origin-with-credentials
CORS(app, origins="*")


@app.route("/a")
# ruleid: jgates.python.cors-any-origin-with-credentials
@cross_origin(supports_credentials=True)
def any_origin():
    return "a"


@app.route("/b")
# ok: jgates.python.cors-any-origin-with-credentials
@cross_origin(supports_credentials=True, origins=["https://app.example.com"])
def listed_origin():
    return "b"


def reflect_origin():
    resp = make_response("x")
    origin = request.headers.get("Origin")
    # ruleid: jgates.python.cors-origin-reflected
    resp.headers["Access-Control-Allow-Origin"] = origin
    # ruleid: jgates.python.cors-origin-reflected
    resp.headers.add("Access-Control-Allow-Origin", request.headers["Origin"])
    # ok: jgates.python.cors-origin-reflected
    resp.headers["Access-Control-Allow-Origin"] = "https://app.example.com"
    if origin in ALLOWED:
        # ok: jgates.python.cors-origin-reflected
        resp.headers["Access-Control-Allow-Origin"] = origin
    return resp


# ruleid: jgates.python.cors-origin-reflected-any-regex
CORS_ALLOWED_ORIGIN_REGEXES = [r".*"]
# ruleid: jgates.python.cors-origin-reflected-any-regex
api.add_middleware(CORSMiddleware, allow_origin_regex=".*")
# ok: jgates.python.cors-origin-reflected-any-regex
CORS_ALLOWED_ORIGIN_REGEXES = [r"^https://.*\.example\.com$"]
# ok: jgates.python.cors-origin-reflected-any-regex
api.add_middleware(CORSMiddleware, allow_origin_regex=r"https://.*\.example\.com")


def jsonp():
    callback = request.args.get("callback")
    # ruleid: jgates.python.jsonp-enabled
    return make_response(callback + "(" + "{}" + ")")
    # ok: jgates.python.jsonp-enabled
    return make_response("{}")
    # ok: jgates.python.jsonp-enabled
    return make_response("fixed(" + "{}" + ")")


def jsonp_django(request):
    name = request.GET.get("jsonp")
    # ruleid: jgates.python.jsonp-enabled
    return HttpResponse(name + "(" + "{}" + ")")


def urls(key, pw):
    # ruleid: jgates.python.sensitive-query-parameter
    requests.get("https://api.example.com/items?api_key=" + key)
    # ruleid: jgates.python.sensitive-query-parameter
    requests.get(f"https://api.example.com/login?password={pw}")
    # ruleid: jgates.python.sensitive-query-parameter
    requests.get("https://api.example.com/items", params={"api_key": key})
    # ruleid: jgates.python.sensitive-query-parameter
    urlencode({"password": pw})
    # ok: jgates.python.sensitive-query-parameter
    requests.get("https://api.example.com/items?page=2", headers={"X-Api-Key": key})
    # ok: jgates.python.sensitive-query-parameter
    requests.post("https://api.example.com/login", data={"password": pw})
