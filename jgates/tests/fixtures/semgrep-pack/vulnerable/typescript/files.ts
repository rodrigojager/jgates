import * as fs from "fs";
import * as path from "path";
import multer from "multer";
import * as tar from "tar";
import type { Request, Response } from "express";

const UPLOAD_DIR: string = "/srv/uploads";
export const upload = multer({ dest: "/tmp/incoming" });
const ALLOWED: string[] = ["image/png", "image/jpeg"];

export function saveAvatar(req: Request & { file: any }, res: Response): void {
  const file = req.file;
  if (!ALLOWED.includes(req.file.mimetype)) {
    res.sendStatus(415);
    return;
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, file.originalname), file.buffer);
  res.sendStatus(201);
}

export function importBackup(archivePath: string, targetDir: string): void {
  tar.x({ file: archivePath, cwd: targetDir });
}

export function download(req: Request, res: Response): void {
  res.setHeader("Content-Disposition", `attachment; filename="${req.query.name}"`);
  res.sendStatus(200);
}
