import express, { Request, Response, NextFunction } from "express";
import errorhandler from "errorhandler";
import swaggerUi from "swagger-ui-express";
import serveIndex from "serve-index";
import { Schema } from "mongoose";

const app = express();
const spec: Record<string, unknown> = require("./openapi.json");

app.use(errorhandler());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(spec));
app.use("/files", express.static("public"), serveIndex("public"));
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Powered-By", "Express 4.18");
  next();
});

const profileSchema = new Schema({ name: String }, { strict: false });

app.post("/users", async (req: Request, res: Response) => {
  const user = await User.create(req.body);
  res.json(user);
});

app.post("/settings/:section", (req: Request, res: Response) => {
  settings[req.params.section][req.body.key] = req.body.value;
  res.sendStatus(204);
});

export function mergeDeep(target: any, source: any): any {
  for (const key in source) {
    if (typeof source[key] === "object") {
      target[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const settings: Record<string, Record<string, unknown>> = {};
function matchesToken(input: string, storedToken: string): boolean {
  return input == storedToken;
}
export { app, profileSchema };
