import bcrypt from "bcrypt";
import Joi from "joi";
import speakeasy from "speakeasy";
import validator from "validator";
import type { Request, Response } from "express";

interface UserRecord {
  id: string;
  name: string;
  role: string;
  passwordHash: string;
  save(): Promise<void>;
}

interface Db {
  users: { findByEmail(email: string): Promise<UserRecord> };
}

export const signupSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(12).max(128).required(),
});

export function checkPassword(password: string): boolean {
  return validator.isLength(password, { min: 12, max: 128 });
}

export async function login(req: Request, res: Response, db: Db): Promise<void> {
  const user: UserRecord = await db.users.findByEmail(req.body.email);
  const ok: boolean = await bcrypt.compare(req.body.password, user.passwordHash);
  if (!ok) {
    res.sendStatus(401);
    return;
  }
  (req as any).session.regenerate((err: Error | null) => {
    if (err) {
      res.sendStatus(500);
      return;
    }
    (req as any).session.userId = user.id;
    res.redirect("/");
  });
}

export async function updateProfile(req: Request, res: Response, user: UserRecord): Promise<void> {
  user.name = req.body.name;
  user.role = "member";
  await user.save();
  res.sendStatus(204);
}

export function verifyCode(token: string, secret: string): boolean {
  return speakeasy.totp.verify({ secret, encoding: "base32", token, window: 1 });
}

export const recoveryFields: Record<string, string> = { recoveryEmail: "user@example.com" };

const passwordInput = document.getElementById("password") as HTMLInputElement;
passwordInput.addEventListener("paste", (event: ClipboardEvent) => console.log(event.type));
