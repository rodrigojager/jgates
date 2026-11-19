import os
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer

import uvicorn
from aiohttp import web
from django import forms
from django.conf import settings
from django.contrib.admin import ModelAdmin
from django.urls import include, path
from django.views.static import serve
from drf_spectacular.views import SpectacularRedocView, SpectacularSwaggerView
from fastapi import FastAPI
from flask import Flask, request
from prometheus_client import start_http_server
from rest_framework import serializers
from starlette.applications import Starlette
from werkzeug.middleware.debug import DebuggedApplication

app = Flask(__name__)


# CF-1 debug mode
# ruleid: jgates.python.debug-mode-enabled
app.run(debug=True)
# ruleid: jgates.python.debug-mode-enabled
app.debug = True
# ruleid: jgates.python.debug-mode-enabled
app.config["DEBUG"] = True
# ruleid: jgates.python.debug-mode-enabled
api = FastAPI(debug=True)
# ruleid: jgates.python.debug-mode-enabled
DEBUG = True

if os.environ.get("APP_ENV") == "development":
    # ok: jgates.python.debug-mode-enabled
    app.run(debug=True)
# ok: jgates.python.debug-mode-enabled
app.run(debug=False)
# ok: jgates.python.debug-mode-enabled
DEBUG = os.environ.get("DEBUG") == "1"


# CF-2 docs and monitoring endpoints
urlpatterns = [
    # ruleid: jgates.python.docs-or-monitoring-endpoint-exposed
    path("docs/", SpectacularSwaggerView.as_view(url_name="schema")),
    # ruleid: jgates.python.docs-or-monitoring-endpoint-exposed
    path("redoc/", SpectacularRedocView.as_view(url_name="schema")),
    # ruleid: jgates.python.docs-or-monitoring-endpoint-exposed
    path("silk/", include("silk.urls")),
    # ok: jgates.python.docs-or-monitoring-endpoint-exposed
    path("accounts/", include("accounts.urls")),
]
# ruleid: jgates.python.docs-or-monitoring-endpoint-exposed
start_http_server(9100)
if settings.DEBUG:
    # ok: jgates.python.docs-or-monitoring-endpoint-exposed
    urlpatterns.append(path("docs/", SpectacularSwaggerView.as_view(url_name="schema")))
# ok: jgates.python.docs-or-monitoring-endpoint-exposed
private_api = FastAPI(docs_url=None, redoc_url=None)


# CF-3 directory listing
# ruleid: jgates.python.directory-listing-enabled
serve(request, "x", document_root="/srv/files", show_indexes=True)
web_app = web.Application()
# ruleid: jgates.python.directory-listing-enabled
web_app.router.add_static("/files", "/srv/files", show_index=True)
# ruleid: jgates.python.directory-listing-enabled
HTTPServer(("", 8000), SimpleHTTPRequestHandler)
# ok: jgates.python.directory-listing-enabled
web_app.router.add_static("/files", "/srv/files", show_index=False)
# ok: jgates.python.directory-listing-enabled
serve(request, "x", document_root="/srv/files", show_indexes=False)
# ok: jgates.python.directory-listing-enabled
ThreadingHTTPServer(("", 8000), MyHandler)


# CF-4 version header
def headers_demo(response):
    # ruleid: jgates.python.version-header-exposed
    response.headers["X-Powered-By"] = "Flask"
    # ruleid: jgates.python.version-header-exposed
    response.headers["Server"] = "Werkzeug/3.0.1"
    # ok: jgates.python.version-header-exposed
    response.headers["Server"] = "web"
    # ok: jgates.python.version-header-exposed
    response.headers["Cache-Control"] = "no-store"


# ruleid: jgates.python.version-header-exposed
uvicorn.run("main:app", server_header=True)
# ok: jgates.python.version-header-exposed
uvicorn.run("main:app", server_header=False)


# CF-5 mass assignment
def create_user(User):
    # ruleid: jgates.python.mass-assignment
    User(**request.json)
    # ruleid: jgates.python.mass-assignment
    User.objects.create(**request.POST.dict())
    # ruleid: jgates.python.mass-assignment
    User(**request.get_json())
    # ok: jgates.python.mass-assignment
    User(name=request.json["name"], email=request.json["email"])
    # ok: jgates.python.mass-assignment
    User.objects.create(name=request.POST["name"])


class OpenForm(forms.ModelForm):
    class Meta:
        model = object
        # ruleid: jgates.python.mass-assignment
        fields = "__all__"


class NarrowForm(forms.ModelForm):
    class Meta:
        model = object
        # ok: jgates.python.mass-assignment
        fields = ["name", "email"]


class PlainAdmin(ModelAdmin):
    # ok: jgates.python.mass-assignment
    fields = "__all__"


# CF-6 serializers
class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = object
        # ruleid: jgates.python.serializer-exposes-all-fields
        fields = "__all__"


class LinkSerializer(serializers.HyperlinkedModelSerializer):
    class Meta:
        model = object
        # ruleid: jgates.python.serializer-exposes-all-fields
        fields = "__all__"


class SafeSerializer(serializers.ModelSerializer):
    class Meta:
        model = object
        # ok: jgates.python.serializer-exposes-all-fields
        fields = ["id", "name"]


class OtherThing(Base):
    # ok: jgates.python.serializer-exposes-all-fields
    fields = "__all__"
