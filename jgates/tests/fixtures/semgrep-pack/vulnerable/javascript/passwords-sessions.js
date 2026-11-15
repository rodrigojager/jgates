const bcrypt = require("bcrypt");
const Joi = require("joi");
const speakeasy = require("speakeasy");
const validator = require("validator");

const signupSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(20).required(),
});

function checkPassword(password) {
  return validator.isStrongPassword(password, { minLength: 12, minUppercase: 1 });
}

async function login(req, res, db) {
  const user = await db.users.findByEmail(req.body.email);
  const ok = await bcrypt.compare(req.body.password.toLowerCase(), user.passwordHash);
  if (!ok) return res.sendStatus(401);
  req.session.userId = user.id;
  return res.redirect("/");
}

async function updateProfile(req, res, user) {
  user.name = req.body.name;
  user.role = req.body.role;
  await user.save();
  res.sendStatus(204);
}

function verifyCode(token, secret) {
  return speakeasy.totp.verify({ secret, encoding: "base32", token, window: 8 });
}

const recoveryFields = { secretQuestion: "Name of your first pet?" };

const passwordInput = document.getElementById("password");
passwordInput.addEventListener("paste", (event) => event.preventDefault());

module.exports = { signupSchema, checkPassword, login, updateProfile, verifyCode, recoveryFields };
