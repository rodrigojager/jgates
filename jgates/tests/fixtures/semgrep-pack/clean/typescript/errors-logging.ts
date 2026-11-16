import express, { Request, Response } from "express";
import axios from "axios";
import Koa from "koa";

const app = express();
const koa = new Koa();
const logger: Console = console;

app.get("/remote-report", async (req: Request, res: Response): Promise<void> => {
  const url: string = validateUrl(req.query.url);
  const report = await axios.get(url, { timeout: 5000, maxRedirects: 0 });
  res.json(report.data);
});

app.post("/login", async (req: Request, res: Response): Promise<void> => {
  const userId: string = String(req.body.userId);
  logger.info("login attempt for " + userId);
  try {
    await axios.get("https://auth.example.com/check", { timeout: 5000 });
  } catch (err: unknown) {
    logger.error(err);
  }
  res.json({ ok: true });
});

app.get("/report", (req: Request, res: Response): void => {
  try {
    buildReport(String(req.query.id));
  } catch (err: any) {
    logger.error(err.stack);
    res.status(500).send("internal error");
  }
});

app.get("/export", (req: Request, res: Response): void => {
  try {
    buildReport(String(req.query.id));
  } catch (error: any) {
    logger.error(error.message);
    res.status(500).json({ error: "internal error" });
  }
});

koa.use(async (ctx: Koa.Context): Promise<void> => {
  try {
    buildReport(String(ctx.query.id));
  } catch (err: any) {
    logger.error(err.stack);
    ctx.body = "internal error";
  }
});

function buildReport(id: string): { id: string } {
  return { id };
}
