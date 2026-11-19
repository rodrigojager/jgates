import strawberry
import websockets
from ariadne.asgi import GraphQL
from flask import Flask, redirect, request
from flask_socketio import SocketIO
from flask_talisman import Talisman

app = Flask(__name__)
Talisman(app, strict_transport_security=False)
socketio = SocketIO(app, cors_allowed_origins="*")


@app.after_request
def add_policy(response):
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'"
    return response


@app.route("/login")
def login():
    return redirect(request.args.get("next"))


@app.route("/whoami")
def whoami():
    return request.headers.get("X-Forwarded-For")


@app.route("/reset")
def reset():
    return "https://" + request.headers.get("Host") + "/reset"


async def listen():
    async with websockets.connect("ws://feed.example.com/stream") as feed:
        return await feed.recv()


def build_api(schema):
    return GraphQL(schema, introspection=True)


def build_unlimited(Query):
    return strawberry.Schema(query=Query)
