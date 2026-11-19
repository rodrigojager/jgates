const crypto = require("crypto");

function digest(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

module.exports = { digest };
