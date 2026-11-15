import os

from flask import Flask, request
from prometheus_client import start_http_server
from rest_framework import serializers

app = Flask(__name__)


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = object
        fields = ["id", "name"]


@app.route("/users", methods=["POST"])
def create_user():
    body = request.json
    return str(User(name=body["name"], email=body["email"]))


@app.route("/files/<name>")
def files(name):
    return name


@app.after_request
def add_headers(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def listing(web_app):
    web_app.router.add_static("/files", "/srv/files", show_index=False)


def monitoring():
    if os.environ.get("APP_ENV") == "development":
        start_http_server(9100)


if __name__ == "__main__":
    app.run(debug=os.environ.get("APP_DEBUG") == "1")
