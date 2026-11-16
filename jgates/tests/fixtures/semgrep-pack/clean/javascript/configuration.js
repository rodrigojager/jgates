const express = require("express");
const errorhandler = require("errorhandler");
const swaggerUi = require("swagger-ui-express");
const { Schema } = require("mongoose");

const app = express();
const spec = require("./openapi.json");

app.disable("x-powered-by");
if (process.env.NODE_ENV === "development") {
  app.use(errorhandler());
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(spec));
}
app.use("/files", express.static("public"));

const profileSchema = new Schema({ name: String }, { strict: true });

app.post("/users", async (req, res) => {
  const user = await User.create({ name: req.body.name, email: req.body.email });
  res.json({ id: user.id, name: user.name });
});

app.post("/settings/:section", (req, res) => {
  settings.preferences[req.body.key] = req.body.value;
  res.sendStatus(204);
});

function mergeDeep(target, source) {
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

const settings = { preferences: {} };
function matchesToken(input, storedToken) {
  return input === storedToken;
}
module.exports = { app, mergeDeep, profileSchema };
