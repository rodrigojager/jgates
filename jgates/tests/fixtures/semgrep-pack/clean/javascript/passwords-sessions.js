const bcrypt = require("bcrypt");
const Joi = require("joi");
const speakeasy = require("speakeasy");
const validator = require("validator");

const signupSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(12).max(128).required(),
});

function checkPassword(password) {
  return validator.isLength(password, { min: 12, max: 128 });
}

async function login(req, res, db) {
  const user = await db.users.findByEmail(req.body.email);
  const ok = await bcrypt.compare(req.body.password, user.passwordHash);
  if (!ok) return res.sendStatus(401);
  req.session.regenerate((err) => {
    if (err) return res.sendStatus(500);
    req.session.userId = user.id;
    return res.redirect("/");
  });
}

async function updateProfile(req, res, user) {
  user.name = req.body.name;
  user.role = "member";
  await user.save();
  res.sendStatus(204);
}

function verifyCode(token, secret) {
  return speakeasy.totp.verify({ secret, encoding: "base32", token, window: 1 });
}

const recoveryFields = { recoveryEmail: "user@example.com" };

const passwordInput = document.getElementById("password");
passwordInput.addEventListener("paste", (event) => console.log(event.type));

module.exports = { signupSchema, checkPassword, login, updateProfile, verifyCode, recoveryFields };
