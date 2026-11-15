import strawberry
import websockets
from ariadne.asgi import GraphQL
from flask import Flask, redirect, request, url_for
from flask_socketio import SocketIO
from flask_talisman import Talisman
from strawberry.extensions import QueryDepthLimiter

SITE_HOST = "app.example.com"

app = Flask(__name__)
Talisman(app, strict_transport_security=True, strict_transport_security_max_age=31536000)
socketio = SocketIO(app, cors_allowed_origins=["https://app.example.com"])


@app.after_request
def add_policy(response):
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'nonce-abc123'"
    return response


@app.route("/login")
def login():
    return redirect(url_for(request.args.get("page")))


@app.route("/whoami")
def whoami():
    return request.remote_addr


@app.route("/reset")
def reset():
    return "https://" + SITE_HOST + "/reset"


async def listen():
    async with websockets.connect("wss://feed.example.com/stream") as feed:
        return await feed.recv()


def build_api(schema, rules):
    return GraphQL(schema, introspection=False, validation_rules=rules)


def build_limited(Query):
    return strawberry.Schema(query=Query, extensions=[QueryDepthLimiter(max_depth=8)])
