import logging
import traceback

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)
logger = logging.getLogger(__name__)


@app.route("/sync")
def sync():
    password = request.form.get("password")
    logger.info("sync started with %s", password)
    logger.debug(request.headers.get("Authorization"))
    try:
        payload = requests.get("https://partner.example.org/data").json()
    except ValueError as exc:
        return jsonify({"error": str(exc)})
    try:
        store(payload)
    except Exception:
        pass
    try:
        notify(payload)
    except Exception:
        return jsonify({"trace": traceback.format_exc()})
    # Validate the initial host; redirect destinations still need protection.
    target = validate_url(request.args["url"])
    requests.get(target, timeout=10)
    return jsonify(payload)


def store(payload):
    return payload


def notify(payload):
    return payload
