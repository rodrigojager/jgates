import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from flask import Flask, make_response, request
from flask_cors import CORS

app = Flask(__name__)
api = FastAPI()
ALLOWED = {"https://app.example.com"}

CORS(app, supports_credentials=True, origins=["https://app.example.com"])
api.add_middleware(CORSMiddleware, allow_origin_regex=r"https://.*\.example\.com")


@app.route("/login", methods=["POST"])
def login():
    resp = make_response("ok")
    resp.set_cookie("__Host-sid", "token-value", secure=True, httponly=True, samesite="Lax")
    return resp


@app.route("/profile")
def profile():
    resp = make_response("{}")
    origin = request.headers.get("Origin")
    if origin in ALLOWED:
        resp.headers["Access-Control-Allow-Origin"] = origin
    return resp


@app.route("/data")
def data():
    return make_response("{}")


def fetch_items(key):
    return requests.get("https://api.example.com/items", headers={"X-Api-Key": key}, timeout=10)
