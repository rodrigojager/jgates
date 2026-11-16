import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import multer from "multer";
import * as tar from "tar";
import contentDisposition from "content-disposition";
import { fileTypeFromBuffer } from "file-type";
import type { Request, Response } from "express";

const UPLOAD_DIR: string = "/srv/uploads";
export const upload = multer({ dest: "/tmp/incoming", limits: { fileSize: 5 * 1024 * 1024 } });
export const memoryUpload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
const ALLOWED: string[] = ["image/png", "image/jpeg"];

export async function saveAvatar(req: Request & { file: any }, res: Response): Promise<void> {
  const file = req.file;
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !ALLOWED.includes(detected.mime)) {
    res.sendStatus(415);
    return;
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, crypto.randomUUID()), file.buffer);
  res.sendStatus(201);
}

export function importBackup(archivePath: string, targetDir: string): void {
  tar.x({
    file: archivePath,
    cwd: targetDir,
    filter: (entryPath: string, stat: fs.Stats) => !stat.isSymbolicLink() && stat.size < 10 * 1024 * 1024,
  });
}

export function download(req: Request, res: Response): void {
  res.setHeader("Content-Disposition", contentDisposition(String(req.query.name)));
  res.sendStatus(200);
}
