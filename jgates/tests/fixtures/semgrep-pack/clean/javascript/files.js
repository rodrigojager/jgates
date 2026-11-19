const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const tar = require("tar");
const contentDisposition = require("content-disposition");
const { fileTypeFromBuffer } = require("file-type");

const UPLOAD_DIR = "/srv/uploads";
const upload = multer({ dest: "/tmp/incoming", limits: { fileSize: 5 * 1024 * 1024 } });
const memoryUpload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
const ALLOWED = ["image/png", "image/jpeg"];

async function saveAvatar(req, res) {
  const file = req.file;
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !ALLOWED.includes(detected.mime)) {
    return res.sendStatus(415);
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, crypto.randomUUID()), file.buffer);
  res.sendStatus(201);
}

function importBackup(archivePath, targetDir) {
  tar.x({
    file: archivePath,
    cwd: targetDir,
    filter: (entryPath, stat) => !stat.isSymbolicLink() && stat.size < 10 * 1024 * 1024,
  });
}

function download(req, res) {
  res.setHeader("Content-Disposition", contentDisposition(req.query.name));
  res.sendStatus(200);
}

module.exports = { upload, memoryUpload, saveAvatar, importBackup, download };
