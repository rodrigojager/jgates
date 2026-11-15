import os
import shutil
import tarfile
import warnings
import zipfile
from pathlib import Path

import magic
from django.http import HttpResponse
from flask import Flask, Response, request
from PIL import Image
from werkzeug.utils import secure_filename
from urllib.parse import quote

app = Flask(__name__)
UPLOAD_DIR = "/srv/uploads"


def save_upload():
    # ruleid: jgates.python.upload-client-filename-in-path
    request.files["doc"].save(os.path.join(UPLOAD_DIR, request.files["doc"].filename))
    upload = request.files["avatar"]
    # ruleid: jgates.python.upload-client-filename-in-path
    upload.save(os.path.join(UPLOAD_DIR, upload.filename))
    # ruleid: jgates.python.upload-client-filename-in-path
    with open(UPLOAD_DIR + "/" + upload.filename, "wb") as out:
        out.write(upload.read())
    # ok: jgates.python.upload-client-filename-in-path
    upload.save(os.path.join(UPLOAD_DIR, secure_filename(upload.filename)))
    # ok: jgates.python.upload-client-filename-in-path
    upload.save(os.path.join(UPLOAD_DIR, os.path.basename(upload.filename)))
    # ok: jgates.python.upload-client-filename-in-path
    upload.save(os.path.join(UPLOAD_DIR, "avatar.png"))


async def save_fastapi(file: UploadFile):
    # ruleid: jgates.python.upload-client-filename-in-path
    target = Path(UPLOAD_DIR) / file.filename
    # ok: jgates.python.upload-client-filename-in-path
    safe = Path(UPLOAD_DIR) / secure_filename(file.filename)


def save_django(request):
    doc = request.FILES["doc"]
    # ruleid: jgates.python.upload-client-filename-in-path
    open(os.path.join(UPLOAD_DIR, doc.name), "wb")
    # ok: jgates.python.upload-client-filename-in-path
    open(os.path.join(UPLOAD_DIR, os.path.basename(doc.name)), "wb")


def unpack(path, dest):
    # ruleid: jgates.python.archive-extraction-unchecked
    tarfile.open(path).extractall(dest)
    with tarfile.open(path) as tar:
        # ruleid: jgates.python.archive-extraction-unchecked
        tar.extractall(dest)
    with tarfile.open(path) as tar:
        for member in tar:
            # ruleid: jgates.python.archive-extraction-unchecked
            tar.extract(member, dest)
    with zipfile.ZipFile(path) as zf:
        # ruleid: jgates.python.archive-extraction-unchecked
        zf.extractall(dest)
    # ruleid: jgates.python.archive-extraction-unchecked
    shutil.unpack_archive(path, dest)
    with tarfile.open(path) as tar:
        # ruleid: jgates.python.archive-extraction-unchecked
        tar.extractall(dest, filter="fully_trusted")


def unpack_safely(path, dest):
    with tarfile.open(path) as tar:
        # ok: jgates.python.archive-extraction-unchecked
        tar.extractall(dest, filter="data")
    with tarfile.open(path) as tar:
        for member in tar:
            # ok: jgates.python.archive-extraction-unchecked
            tar.extract(member, dest, filter="data")
    with zipfile.ZipFile(path) as zf:
        total = sum(info.file_size for info in zf.infolist())
        if total > 100_000_000:
            raise ValueError("archive too large")
        # ok: jgates.python.archive-extraction-unchecked
        zf.extractall(dest)
    # ok: jgates.python.archive-extraction-unchecked
    shutil.unpack_archive(path, dest, filter="data")


def configure(settings):
    # ruleid: jgates.python.request-body-without-size-limit
    app.config["MAX_CONTENT_LENGTH"] = None
    # ruleid: jgates.python.request-body-without-size-limit
    app.config.update(MAX_CONTENT_LENGTH=None)
    # ruleid: jgates.python.request-body-without-size-limit
    DATA_UPLOAD_MAX_MEMORY_SIZE = None
    # ok: jgates.python.request-body-without-size-limit
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
    # ok: jgates.python.request-body-without-size-limit
    DATA_UPLOAD_MAX_MEMORY_SIZE = 5242880


# ruleid: jgates.python.image-pixel-limit-disabled
Image.MAX_IMAGE_PIXELS = None
# ruleid: jgates.python.image-pixel-limit-disabled
warnings.simplefilter("ignore", Image.DecompressionBombWarning)
# ok: jgates.python.image-pixel-limit-disabled
Image.MAX_IMAGE_PIXELS = 50_000_000
# ok: jgates.python.image-pixel-limit-disabled
warnings.simplefilter("error", Image.DecompressionBombWarning)


def check_type(request, file: UploadFile):
    # ruleid: jgates.python.upload-content-type-trusted
    if request.files["doc"].mimetype in ("image/png", "image/jpeg"):
        pass
    # ruleid: jgates.python.upload-content-type-trusted
    if file.content_type == "application/pdf":
        pass
    # ok: jgates.python.upload-content-type-trusted
    if magic.from_buffer(request.files["doc"].read(2048), mime=True) in ("image/png",):
        pass
    # ok: jgates.python.upload-content-type-trusted
    if file.filename.endswith(".pdf"):
        pass


def download():
    name = request.args.get("name")
    resp = Response("data")
    # ruleid: jgates.python.content-disposition-from-request
    resp.headers["Content-Disposition"] = "attachment; filename=" + name
    # ruleid: jgates.python.content-disposition-from-request
    resp.headers.set("Content-Disposition", f"attachment; filename={name}")
    # ruleid: jgates.python.content-disposition-from-request
    return Response("data", headers={"Content-Disposition": f"attachment; filename={name}"})


def download_safe():
    name = request.args.get("name")
    resp = Response("data")
    # ok: jgates.python.content-disposition-from-request
    resp.headers["Content-Disposition"] = "attachment; filename=" + secure_filename(name)
    # ok: jgates.python.content-disposition-from-request
    resp.headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(name)
    # ok: jgates.python.content-disposition-from-request
    resp.headers["Content-Disposition"] = 'attachment; filename="report.pdf"'


def download_django(request):
    response = HttpResponse("data")
    # ruleid: jgates.python.content-disposition-from-request
    response["Content-Disposition"] = "attachment; filename=" + request.GET["name"]
    # ok: jgates.python.content-disposition-from-request
    response["Content-Disposition"] = "attachment; filename=" + quote(request.GET["name"])
