import os
import tarfile
import uuid
from urllib.parse import quote

import magic
from flask import Flask, Response, request
from PIL import Image

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 50_000_000
UPLOAD_DIR = "/srv/uploads"


@app.route("/upload", methods=["POST"])
def upload():
    doc = request.files["doc"]
    if magic.from_buffer(doc.read(2048), mime=True) not in ("application/pdf", "image/png"):
        return "unsupported", 400
    doc.seek(0)
    doc.save(os.path.join(UPLOAD_DIR, uuid.uuid4().hex))
    return "stored"


@app.route("/import", methods=["POST"])
def import_archive():
    with tarfile.open(fileobj=request.files["bundle"].stream) as tar:
        tar.extractall(UPLOAD_DIR, filter="data")
    with tarfile.open(fileobj=request.files["trusted_bundle"].stream) as tar:
        tar.extractall(UPLOAD_DIR, filter="data")
    return "imported"


@app.route("/export")
def export():
    name = request.args.get("name")
    resp = Response("data")
    resp.headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(name)
    return resp
