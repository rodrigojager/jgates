import express, { Request, Response } from "express";
import cors from "cors";
import lusca from "lusca";

const app = express();
const allowedOrigins: string[] = ["https://app.example.com"];

app.use(cors({ origin: allowedOrigins }));
app.use(lusca({ csrf: true }));

app.post("/login", (req: Request, res: Response): void => {
  const token: string = String(req.body.sessionRef);
  res.cookie("__Host-secure-on", token, { secure: true, httpOnly: true, sameSite: "lax" });
  res.cookie("__Host-script-hidden", token, { secure: true, httpOnly: true, sameSite: "lax" });
  res.cookie("__Host-same-site", token, { secure: true, httpOnly: true, sameSite: "strict" });
  res.cookie("__Host-sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
  const origin = req.headers.origin as string;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.json({ ok: true });
});

app.get("/feed", (req: Request, res: Response): void => {
  const data: { items: string[] } = { items: [] };
  res.json(data);
});

app.get("/legacy", (req: Request, res: Response): void => {
  res.json({ items: [] });
});

async function loadItems(key: string): Promise<unknown> {
  const response: globalThis.Response = await fetch("https://api.example.com/v1/items?page=1", { headers: { Authorization: "Bearer " + key } });
  return response.json();
}

function remember(theme: string): void {
  localStorage.setItem("theme", theme);
  sessionStorage.setItem("last_view", "feed");
}
