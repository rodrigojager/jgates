from flask import Flask, request
from prometheus_client import start_http_server
from rest_framework import serializers

app = Flask(__name__)


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = object
        fields = "__all__"


@app.route("/users", methods=["POST"])
def create_user():
    return str(User(**request.json))


@app.route("/files/<name>")
def files(name):
    return name


@app.after_request
def add_headers(response):
    response.headers["X-Powered-By"] = "Flask"
    return response


def listing(web_app):
    web_app.router.add_static("/files", "/srv/files", show_index=True)


def monitoring():
    start_http_server(9100)


if __name__ == "__main__":
    app.run(debug=True)
