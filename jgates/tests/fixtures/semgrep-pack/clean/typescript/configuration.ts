import express, { Request, Response } from "express";
import errorhandler from "errorhandler";
import swaggerUi from "swagger-ui-express";
import { Schema } from "mongoose";

const app = express();
const spec: Record<string, unknown> = require("./openapi.json");

app.disable("x-powered-by");
if (process.env.NODE_ENV === "development") {
  app.use(errorhandler());
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(spec));
}
app.use("/files", express.static("public"));

const profileSchema = new Schema({ name: String }, { strict: true });

app.post("/users", async (req: Request, res: Response) => {
  const user = await User.create({ name: req.body.name, email: req.body.email });
  res.json(user);
});

app.post("/settings/:section", (req: Request, res: Response) => {
  settings.preferences[req.body.key] = req.body.value;
  res.sendStatus(204);
});

export function mergeDeep(target: any, source: any): any {
  for (const key in source) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (typeof source[key] === "object") {
      target[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const settings: Record<string, Record<string, unknown>> = { preferences: {} };
export { app, profileSchema };
