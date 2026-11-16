const express = require("express");
const errorhandler = require("errorhandler");
const swaggerUi = require("swagger-ui-express");
const serveIndex = require("serve-index");
const { Schema } = require("mongoose");

const app = express();
const spec = require("./openapi.json");

app.use(errorhandler());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(spec));
app.use("/files", express.static("public"), serveIndex("public"));
app.use((req, res, next) => {
  res.setHeader("X-Powered-By", "Express 4.18");
  next();
});

const profileSchema = new Schema({ name: String }, { strict: false });

app.post("/users", async (req, res) => {
  const user = await User.create(req.body);
  res.json(user);
});

app.post("/settings/:section", (req, res) => {
  settings[req.params.section][req.body.key] = req.body.value;
  res.sendStatus(204);
});

function mergeDeep(target, source) {
  for (const key in source) {
    if (typeof source[key] === "object") {
      target[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const settings = {};
function matchesToken(input, storedToken) {
  return input == storedToken;
}
module.exports = { app, mergeDeep, profileSchema };
