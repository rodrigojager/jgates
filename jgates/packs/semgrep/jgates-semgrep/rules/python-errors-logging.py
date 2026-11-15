import contextlib
import http.client
import logging
import traceback
import urllib.request
from contextlib import suppress

import requests
from django.http import HttpResponse, JsonResponse
from flask import Flask, abort, jsonify, make_response, request

app = Flask(__name__)
logger = logging.getLogger(__name__)


def log_values(user, password, api_key, token, user_id, request_id):
    # ruleid: jgates.python.sensitive-data-logged
    logger.info("login with %s", password)
    # ruleid: jgates.python.sensitive-data-logged
    logging.debug(f"calling the API with {api_key}")
    # ruleid: jgates.python.sensitive-data-logged
    app.logger.warning("session token", token)
    # ruleid: jgates.python.sensitive-data-logged
    logger.error("bad login %s" % user.password)
    # ok: jgates.python.sensitive-data-logged
    logger.info("login with %s", user_id)
    # ok: jgates.python.sensitive-data-logged
    logging.debug("token refreshed for request %s", request_id)
    # ok: jgates.python.sensitive-data-logged
    logger.info("password length %d", len(password))
    # ok: jgates.python.sensitive-data-logged
    print(password)


def log_header():
    # ruleid: jgates.python.sensitive-data-logged-header
    logger.info("headers", request.headers["Authorization"])
    # ruleid: jgates.python.sensitive-data-logged-header
    logging.debug(request.headers.get("Authorization"))
    # ok: jgates.python.sensitive-data-logged-header
    logger.info("agent %s", request.headers.get("User-Agent"))
    # ok: jgates.python.sensitive-data-logged-header
    logger.info("path %s", request.path)


@app.route("/trace")
def trace_view():
    try:
        run()
    except Exception:
        # ruleid: jgates.python.stack-trace-in-response
        return HttpResponse(traceback.format_exc())
    try:
        run()
    except Exception:
        trace = traceback.format_exc()
        # ruleid: jgates.python.stack-trace-in-response
        return jsonify({"trace": trace})
    try:
        run()
    except Exception:
        # ruleid: jgates.python.stack-trace-in-response
        abort(500, traceback.format_exc())
    try:
        run()
    except Exception:
        # ruleid: jgates.python.stack-trace-in-response
        return traceback.format_exc()
    try:
        run()
    except Exception:
        logger.error(traceback.format_exc())
        # ok: jgates.python.stack-trace-in-response
        return make_response("Something went wrong", 500)
    try:
        run()
    except Exception:
        logger.exception("failed")
        # ok: jgates.python.stack-trace-in-response
        return JsonResponse({"error": "internal error"}, status=500)


def trace_helper():
    # ok: jgates.python.stack-trace-in-response
    return traceback.format_exc()


def error_detail():
    try:
        run()
    except ValueError as exc:
        # ruleid: jgates.python.error-detail-in-response
        return JsonResponse({"error": str(exc)})
    try:
        run()
    except OSError as err:
        # ruleid: jgates.python.error-detail-in-response
        return make_response(f"failed: {err}", 500)
    try:
        run()
    except OSError as err:
        logger.error("failed: %s", err)
        # ok: jgates.python.error-detail-in-response
        return make_response("failed", 500)
    try:
        run()
    except OSError as err:
        logger.error("failed: %s", err)
        # ok: jgates.python.error-detail-in-response
        return jsonify({"error": "internal error"})


def swallow():
    # ruleid: jgates.python.swallowed-exception
    try:
        run()
    except Exception:
        pass
    # ruleid: jgates.python.swallowed-exception
    try:
        run()
    except:
        pass
    for item in range(3):
        # ruleid: jgates.python.swallowed-exception
        try:
            run()
        except Exception as exc:
            continue
    # ruleid: jgates.python.swallowed-exception
    with contextlib.suppress(Exception):
        run()
    # ok: jgates.python.swallowed-exception
    try:
        run()
    except Exception:
        logger.exception("run failed")
    # ok: jgates.python.swallowed-exception
    try:
        run()
    except Exception:
        raise
    # ok: jgates.python.swallowed-exception
    try:
        import json
    except ImportError:
        pass
    # ok: jgates.python.swallowed-exception
    with suppress(FileNotFoundError):
        run()


def outbound(url, session_headers):
    # ruleid: jgates.python.http-client-without-timeout
    requests.get(url)
    # ruleid: jgates.python.http-client-without-timeout
    requests.post(url, json={"a": 1}, headers=session_headers)
    # ruleid: jgates.python.http-client-without-timeout
    requests.get(url, timeout=None)
    # ruleid: jgates.python.http-client-without-timeout
    urllib.request.urlopen(url)
    # ruleid: jgates.python.http-client-without-timeout
    http.client.HTTPSConnection("example.org")
    session = requests.Session()
    # ruleid: jgates.python.http-client-without-timeout
    session.get(url)
    # ok: jgates.python.http-client-without-timeout
    requests.get(url, timeout=10)
    # ok: jgates.python.http-client-without-timeout
    requests.post(url, json={"a": 1}, timeout=(3, 10))
    # ok: jgates.python.http-client-without-timeout
    urllib.request.urlopen(url, timeout=10)
    # ok: jgates.python.http-client-without-timeout
    http.client.HTTPSConnection("example.org", timeout=10)
    other = requests.Session()
    # ok: jgates.python.http-client-without-timeout
    other.get(url, timeout=10)


def run():
    return None
