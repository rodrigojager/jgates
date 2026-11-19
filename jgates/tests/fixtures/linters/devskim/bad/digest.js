const crypto = require("crypto");

function digest(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

module.exports = { digest };
