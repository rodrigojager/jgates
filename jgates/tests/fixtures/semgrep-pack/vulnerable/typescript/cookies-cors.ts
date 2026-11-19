import express, { Request, Response } from "express";
import cors from "cors";
import lusca from "lusca";

const app = express();

app.use(cors({ origin: true }));
app.use(lusca({ csrf: false }));

app.post("/login", (req: Request, res: Response): void => {
  const token: string = String(req.body.sessionRef);
  res.cookie("__Host-secure-off", token, { secure: false, httpOnly: true, sameSite: "lax" });
  res.cookie("__Host-script-readable", token, { secure: true, httpOnly: false, sameSite: "lax" });
  res.cookie("__Host-secure-default", token, { httpOnly: true, sameSite: "lax" });
  res.cookie("__Host-script-default", token, { secure: true, sameSite: "lax" });
  res.cookie("__Host-cross-site", token, { secure: true, httpOnly: true, sameSite: "none" });
  res.cookie("sid", token, { secure: true, httpOnly: true, sameSite: "lax" });
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin as string);
  res.json({ ok: true });
});

app.get("/feed", (req: Request, res: Response): void => {
  const data: { items: string[] } = { items: [] };
  res.end(encodeURIComponent(String(req.query.callback)) + "(" + JSON.stringify(data) + ")");
});

app.get("/legacy", (req: Request, res: Response): void => {
  res.jsonp({ items: [] });
});

async function loadItems(key: string): Promise<unknown> {
  const response: globalThis.Response = await fetch("https://api.example.com/v1/items?api_key=" + key);
  return response.json();
}

function remember(password: string, accessToken: string): void {
  localStorage.setItem("password", password);
  sessionStorage.setItem("access_token", accessToken);
}
