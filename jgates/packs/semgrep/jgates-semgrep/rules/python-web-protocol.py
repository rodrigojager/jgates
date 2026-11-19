import socketio
import strawberry
import websocket
import websockets
from ariadne.asgi import GraphQL
from flask import redirect, request, url_for
from flask_socketio import SocketIO
from flask_talisman import Talisman
from django.http import HttpResponseRedirect
from django.urls import reverse
from strawberry.extensions import QueryDepthLimiter
from tornado.websocket import WebSocketHandler


def talisman(app):
    # ruleid: jgates.python.security-headers-disabled
    Talisman(app, strict_transport_security=False)
    # ruleid: jgates.python.security-headers-disabled
    Talisman(app, content_security_policy=None)
    # ruleid: jgates.python.security-headers-disabled
    Talisman(app, frame_options=None)
    # ruleid: jgates.python.security-headers-disabled
    Talisman(app, strict_transport_security_max_age=3600)
    # ok: jgates.python.security-headers-disabled
    Talisman(app, strict_transport_security=True, strict_transport_security_max_age=31536000)
    # ok: jgates.python.security-headers-disabled
    Talisman(app, frame_options="DENY")


# ruleid: jgates.python.security-headers-disabled
SECURE_CONTENT_TYPE_NOSNIFF = False
# ruleid: jgates.python.security-headers-disabled
SECURE_HSTS_SECONDS = 0
# ruleid: jgates.python.security-headers-disabled
SECURE_HSTS_SECONDS = 86400
# ok: jgates.python.security-headers-disabled
SECURE_HSTS_SECONDS = 31536000
# ok: jgates.python.security-headers-disabled
SECURE_CONTENT_TYPE_NOSNIFF = True


def csp(response):
    # ruleid: jgates.python.csp-unsafe-directive
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'"
    # ruleid: jgates.python.csp-unsafe-directive
    response.headers.set("Content-Security-Policy", "script-src 'unsafe-eval' https://cdn.example.com")
    # ruleid: jgates.python.csp-unsafe-directive
    response["Content-Security-Policy"] = "script-src *"
    # ok: jgates.python.csp-unsafe-directive
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'nonce-abc123'"
    # ok: jgates.python.csp-unsafe-directive
    response.headers["Content-Security-Policy"] = "script-src 'self'; style-src 'self' 'unsafe-inline'"
    # ok: jgates.python.csp-unsafe-directive
    response.headers["X-Frame-Options"] = "DENY"


def csp_talisman(app):
    # ruleid: jgates.python.csp-unsafe-directive-talisman
    Talisman(app, content_security_policy={"script-src": ["'self'", "'unsafe-inline'"]})
    # ruleid: jgates.python.csp-unsafe-directive-talisman
    Talisman(app, content_security_policy={"default-src": "*"})
    # ok: jgates.python.csp-unsafe-directive-talisman
    Talisman(app, content_security_policy={"script-src": ["'self'"]})
    # ok: jgates.python.csp-unsafe-directive-talisman
    Talisman(app, content_security_policy={"style-src": ["'self'", "'unsafe-inline'"]})


async def sockets(session):
    # ruleid: jgates.python.websocket-without-tls
    websocket.create_connection("ws://feed.example.com/stream")
    # ruleid: jgates.python.websocket-without-tls
    await websockets.connect("ws://feed.example.com:8080/stream")
    # ruleid: jgates.python.websocket-without-tls
    await session.ws_connect("ws://api.example.com/socket")
    # ok: jgates.python.websocket-without-tls
    websocket.create_connection("wss://feed.example.com/stream")
    # ok: jgates.python.websocket-without-tls
    await websockets.connect("ws://localhost:8765")
    # ok: jgates.python.websocket-without-tls
    await websockets.connect("ws://127.0.0.1:8765")


class Feed(WebSocketHandler):
    # ruleid: jgates.python.websocket-origin-not-checked
    def check_origin(self, origin):
        return True


class Chat(WebSocketHandler):
    # ok: jgates.python.websocket-origin-not-checked
    def check_origin(self, origin):
        return origin == "https://app.example.com"


def socket_servers(app):
    # ruleid: jgates.python.websocket-origin-not-checked
    SocketIO(app, cors_allowed_origins="*")
    # ruleid: jgates.python.websocket-origin-not-checked
    socketio.AsyncServer(cors_allowed_origins="*")
    # ok: jgates.python.websocket-origin-not-checked
    SocketIO(app, cors_allowed_origins=["https://app.example.com"])
    # ok: jgates.python.websocket-origin-not-checked
    socketio.AsyncServer(cors_allowed_origins="https://app.example.com")


def graphql_servers(schema, rules):
    # ruleid: jgates.python.graphql-introspection-enabled
    GraphQL(schema, validation_rules=rules, introspection=True)
    # ruleid: jgates.python.graphql-introspection-enabled
    GraphQL(schema, debug=False, validation_rules=rules, introspection=True)
    # ok: jgates.python.graphql-introspection-enabled
    GraphQL(schema, validation_rules=rules, introspection=False)
    # ok: jgates.python.graphql-introspection-enabled
    GraphQL(schema, validation_rules=rules, debug=False)


def graphql_limits(schema, rules, Query):
    # ruleid: jgates.python.graphql-without-depth-limit
    GraphQL(schema)
    # ruleid: jgates.python.graphql-without-depth-limit
    strawberry.Schema(query=Query)
    # ok: jgates.python.graphql-without-depth-limit
    GraphQL(schema, validation_rules=rules)
    # ok: jgates.python.graphql-without-depth-limit
    strawberry.Schema(query=Query, extensions=[QueryDepthLimiter(max_depth=8)])


def redirects():
    target = request.args.get("next")
    # ruleid: jgates.python.open-redirect
    redirect(target)
    # ruleid: jgates.python.open-redirect
    HttpResponseRedirect(request.GET.get("next", "/"))
    # ok: jgates.python.open-redirect
    redirect("/dashboard")
    # ok: jgates.python.open-redirect
    redirect(url_for(request.args.get("page")))
    # ok: jgates.python.open-redirect
    HttpResponseRedirect(reverse(request.GET.get("view")))


def client_address():
    # ruleid: jgates.python.client-ip-from-forwarded-header
    ip = request.headers.get("X-Forwarded-For")
    # ruleid: jgates.python.client-ip-from-forwarded-header
    ip = request.META["HTTP_X_FORWARDED_FOR"]
    # ruleid: jgates.python.client-ip-from-forwarded-header
    ip = request.headers["X-Real-IP"]
    # ok: jgates.python.client-ip-from-forwarded-header
    ip = request.remote_addr
    # ok: jgates.python.client-ip-from-forwarded-header
    ip = request.META.get("REMOTE_ADDR")
    # ok: jgates.python.client-ip-from-forwarded-header
    agent = request.headers.get("User-Agent")


def absolute_links(settings):
    # ruleid: jgates.python.host-header-in-url
    link = "https://" + request.headers.get("Host") + "/reset"
    host = request.host
    # ruleid: jgates.python.host-header-in-url
    link = f"https://{host}/confirm"
    # ok: jgates.python.host-header-in-url
    link = "https://" + settings.SITE_HOST + "/reset"
    # ok: jgates.python.host-header-in-url
    link = f"https://{settings.SITE_HOST}/confirm"
