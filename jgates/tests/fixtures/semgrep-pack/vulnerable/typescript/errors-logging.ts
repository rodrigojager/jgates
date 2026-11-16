import express, { Request, Response } from "express";
import axios from "axios";
import Koa from "koa";

const app = express();
const koa = new Koa();

app.get("/remote-report", async (req: Request, res: Response): Promise<void> => {
  const url: string = validateUrl(req.query.url);
  const report = await axios.get(url, { timeout: 5000 });
  res.json(report.data);
});

app.post("/login", async (req: Request, res: Response): Promise<void> => {
  const password: string = loadCredential(req);
  console.info("login attempt with " + password);
  try {
    await axios.get("https://auth.example.com/check");
  } catch (err: unknown) {}
  res.json({ ok: true });
});

app.get("/report", (req: Request, res: Response): void => {
  try {
    buildReport(String(req.query.id));
  } catch (err: any) {
    res.status(500).send(err.stack);
  }
});

app.get("/export", (req: Request, res: Response): void => {
  try {
    buildReport(String(req.query.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

koa.use(async (ctx: Koa.Context): Promise<void> => {
  try {
    buildReport(String(ctx.query.id));
  } catch (err: any) {
    ctx.body = err.stack;
  }
});

function loadCredential(req: Request): string {
  return String(req.session.credential);
}

function buildReport(id: string): { id: string } {
  return { id };
}
