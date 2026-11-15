import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from flask import Flask, make_response, request
from flask_cors import CORS

app = Flask(__name__)
api = FastAPI()

CORS(app, supports_credentials=True)
api.add_middleware(CORSMiddleware, allow_origin_regex=".*")


@app.route("/login", methods=["POST"])
def login():
    resp = make_response("ok")
    resp.set_cookie("sid", "token-value", secure=False, httponly=False, samesite="None")
    return resp


@app.route("/profile")
def profile():
    resp = make_response("{}")
    resp.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin")
    return resp


@app.route("/data")
def data():
    callback = request.args.get("callback")
    return make_response(callback + "({})")


def fetch_items(key):
    return requests.get("https://api.example.com/items?api_key=" + key, timeout=10)
