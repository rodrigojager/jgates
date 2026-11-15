const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const fileUpload = require("express-fileupload");
const Busboy = require("busboy");
const express = require("express");
const bodyParser = require("body-parser");
const formidable = require("formidable");
const tar = require("tar");
const unzipper = require("unzipper");
const AdmZip = require("adm-zip");
const contentDisposition = require("content-disposition");

const UPLOAD_DIR = "/srv/uploads";

function storeUpload(req, res) {
  const file = req.file;
  // ruleid: jgates.js.upload-client-filename-in-path
  fs.writeFileSync(path.join(UPLOAD_DIR, file.originalname), file.buffer);
  // ruleid: jgates.js.upload-client-filename-in-path
  fs.renameSync(file.path, path.join(UPLOAD_DIR, req.files.avatar.name));
  // ruleid: jgates.js.upload-client-filename-in-path
  fs.createWriteStream(path.resolve(UPLOAD_DIR, file.originalFilename));
  // ok: jgates.js.upload-client-filename-in-path
  fs.writeFileSync(path.join(UPLOAD_DIR, path.basename(file.originalname)), file.buffer);
  // ok: jgates.js.upload-client-filename-in-path
  fs.writeFileSync(path.join(UPLOAD_DIR, crypto.randomUUID()), file.buffer);
  // ok: jgates.js.upload-client-filename-in-path
  const stored = crypto.randomUUID();
  fs.renameSync(file.path, path.join(UPLOAD_DIR, stored));
}

function unpack(zipPath, dir, input, entryStream) {
  const zip = new AdmZip(zipPath);
  // ruleid: jgates.js.archive-extraction-unchecked
  zip.extractAllTo(dir, true);
  // ruleid: jgates.js.archive-extraction-unchecked
  new AdmZip(input).extractAllTo(dir);
  // ruleid: jgates.js.archive-extraction-unchecked
  tar.x({ file: zipPath, cwd: dir });
  // ruleid: jgates.js.archive-extraction-unchecked
  fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: dir }));
  // ruleid: jgates.js.archive-extraction-unchecked
  tar.extract({ file: zipPath, cwd: dir, strip: 1 });
  entryStream.on("entry", (entry) => {
    // ruleid: jgates.js.archive-extraction-unchecked
    entry.pipe(fs.createWriteStream(path.join(dir, entry.path)));
  });
  // ok: jgates.js.archive-extraction-unchecked
  tar.x({
    file: zipPath,
    cwd: dir,
    filter: (p, stat) => !stat.isSymbolicLink() && stat.size < 10 * 1024 * 1024,
  });
  entryStream.on("entry", (entry) => {
    const target = path.resolve(dir, entry.path);
    // ok: jgates.js.archive-extraction-unchecked
    if (target.startsWith(path.resolve(dir) + path.sep)) {
      entry.pipe(fs.createWriteStream(path.join(dir, entry.path)));
    }
  });
  // ok: jgates.js.archive-extraction-unchecked
  zip.getEntries().forEach((e) => zip.extractEntryTo(e, dir, false, true));
}

function configureUploads(app) {
  // ruleid: jgates.js.request-body-without-size-limit
  const a = multer({ dest: "uploads/" });
  // ruleid: jgates.js.request-body-without-size-limit
  const b = multer();
  // ruleid: jgates.js.request-body-without-size-limit
  app.use(fileUpload());
  // ruleid: jgates.js.request-body-without-size-limit
  app.use(fileUpload({ createParentPath: true }));
  // ruleid: jgates.js.request-body-without-size-limit
  const bb = new Busboy({ headers: app.headers });
  // ruleid: jgates.js.request-body-without-size-limit
  app.use(express.json({ limit: Infinity }));
  // ruleid: jgates.js.request-body-without-size-limit
  app.use(bodyParser.urlencoded({ extended: true, limit: Infinity }));
  // ruleid: jgates.js.request-body-without-size-limit
  const form = formidable({ maxFileSize: Infinity });
  // ruleid: jgates.js.request-body-without-size-limit
  const c = multer({ limits: { fileSize: Infinity } });
  // ok: jgates.js.request-body-without-size-limit
  const d = multer({ dest: "uploads/", limits: { fileSize: 5 * 1024 * 1024 } });
  // ok: jgates.js.request-body-without-size-limit
  app.use(fileUpload({ limits: { fileSize: 5 * 1024 * 1024 }, abortOnLimit: true }));
  // ok: jgates.js.request-body-without-size-limit
  const bb2 = Busboy({ headers: app.headers, limits: { fileSize: 1024 * 1024 } });
  // ok: jgates.js.request-body-without-size-limit
  app.use(express.json({ limit: "100kb" }));
  // ok: jgates.js.request-body-without-size-limit
  const form2 = formidable({ maxFileSize: 5 * 1024 * 1024 });
}

const ALLOWED = ["image/png", "image/jpeg"];

function checkType(req, res) {
  // ruleid: jgates.js.upload-content-type-trusted
  if (!ALLOWED.includes(req.file.mimetype)) {
    return res.sendStatus(415);
  }
  // ruleid: jgates.js.upload-content-type-trusted
  if (req.files.photo.mimetype !== "image/png") {
    return res.sendStatus(415);
  }
  // ok: jgates.js.upload-content-type-trusted
  const detected = fileTypeFromBuffer(req.file.buffer);
  if (!detected || !ALLOWED.includes(detected.mime)) {
    return res.sendStatus(415);
  }
  // ok: jgates.js.upload-content-type-trusted
  if (req.file.size > 1024) {
    return res.sendStatus(413);
  }
}

const filtered = multer({
  limits: { fileSize: 1024 },
  fileFilter: (req, file, cb) => {
    // ruleid: jgates.js.upload-content-type-trusted
    cb(null, ALLOWED.includes(file.mimetype));
  },
});

function sendFiles(req, res) {
  // ruleid: jgates.js.content-disposition-from-request
  res.setHeader("Content-Disposition", `attachment; filename="${req.query.name}"`);
  // ruleid: jgates.js.content-disposition-from-request
  res.set("content-disposition", "attachment; filename=" + req.params.file);
  // ruleid: jgates.js.content-disposition-from-request
  res.writeHead(200, { "Content-Disposition": `attachment; filename=${req.body.name}` });
  // ok: jgates.js.content-disposition-from-request
  res.setHeader("Content-Disposition", contentDisposition(req.query.name));
  // ok: jgates.js.content-disposition-from-request
  res.setHeader("Content-Disposition", "attachment; filename=\"report.pdf\"");
  // ok: jgates.js.content-disposition-from-request
  res.attachment(req.query.name);
}
