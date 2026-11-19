import logging

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)
logger = logging.getLogger(__name__)


@app.route("/sync")
def sync():
    user_id = request.form.get("user_id")
    logger.info("sync started for user %s", user_id)
    logger.debug("path %s", request.path)
    try:
        payload = requests.get("https://partner.example.org/data", timeout=10).json()
    except ValueError as exc:
        logger.error("partner answer is not valid JSON: %s", exc)
        return jsonify({"error": "invalid partner answer"}), 502
    try:
        store(payload)
    except Exception:
        logger.exception("store failed")
    try:
        notify(payload)
    except Exception:
        logger.exception("notify failed")
        return jsonify({"error": "internal error"}), 500
    # Validate the initial host and do not follow redirects to other hosts.
    target = validate_url(request.args["url"])
    requests.get(target, allow_redirects=False, timeout=10)
    return jsonify(payload)


def store(payload):
    return payload


def notify(payload):
    return payload
