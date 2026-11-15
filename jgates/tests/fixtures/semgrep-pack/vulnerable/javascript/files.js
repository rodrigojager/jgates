const fs = require("fs");
const path = require("path");
const multer = require("multer");
const tar = require("tar");

const UPLOAD_DIR = "/srv/uploads";
const upload = multer({ dest: "/tmp/incoming" });
const ALLOWED = ["image/png", "image/jpeg"];

function saveAvatar(req, res) {
  const file = req.file;
  if (!ALLOWED.includes(req.file.mimetype)) {
    return res.sendStatus(415);
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, file.originalname), file.buffer);
  res.sendStatus(201);
}

function importBackup(archivePath, targetDir) {
  tar.x({ file: archivePath, cwd: targetDir });
}

function download(req, res) {
  res.setHeader("Content-Disposition", `attachment; filename="${req.query.name}"`);
  res.sendStatus(200);
}

module.exports = { upload, saveAvatar, importBackup, download };
