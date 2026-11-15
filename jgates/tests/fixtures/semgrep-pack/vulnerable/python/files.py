import os
import tarfile
import warnings

from flask import Flask, Response, request
from PIL import Image

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = None
Image.MAX_IMAGE_PIXELS = None
UPLOAD_DIR = "/srv/uploads"


@app.route("/upload", methods=["POST"])
def upload():
    doc = request.files["doc"]
    if doc.mimetype not in ("application/pdf", "image/png"):
        return "unsupported", 400
    doc.save(os.path.join(UPLOAD_DIR, doc.filename))
    return "stored"


@app.route("/import", methods=["POST"])
def import_archive():
    with tarfile.open(fileobj=request.files["bundle"].stream) as tar:
        tar.extractall(UPLOAD_DIR)
    return "imported"


@app.route("/export")
def export():
    name = request.args.get("name")
    resp = Response("data")
    resp.headers["Content-Disposition"] = "attachment; filename=" + name
    return resp
