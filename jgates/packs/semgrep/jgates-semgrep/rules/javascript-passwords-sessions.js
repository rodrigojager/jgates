const Joi = require("joi");
const { z } = require("zod");
const yup = require("yup");
const validator = require("validator");
const { body } = require("express-validator");
const bcrypt = require("bcrypt");
const argon2 = require("argon2");
const crypto = require("crypto");
const speakeasy = require("speakeasy");
const { authenticator } = require("otplib");
const OTPAuth = require("otpauth");
const PasswordValidator = require("password-validator");

// ---- password-min-length-below-8 ----
const joiShort = Joi.object({
  // ruleid: jgates.js.password-min-length-below-8
  password: Joi.string().min(6).required(),
});
const zodShort = z.object({
  // ruleid: jgates.js.password-min-length-below-8
  password: z.string().min(4, "too short"),
});
const yupShort = yup.object({
  // ruleid: jgates.js.password-min-length-below-8
  newPassword: yup.string().required().min(5),
});
const mongooseShort = {
  // ruleid: jgates.js.password-min-length-below-8
  password: { type: String, minlength: 6 },
};
const sequelizeShort = {
  // ruleid: jgates.js.password-min-length-below-8
  senha: { type: "STRING", validate: { len: [4, 100] } },
};
// ruleid: jgates.js.password-min-length-below-8
const evMin = body("password").trim().isLength({ min: 6 });
// ruleid: jgates.js.password-min-length-below-8
const lenOk = validator.isLength(password, { min: 3 });
function checkLength(password) {
  // ruleid: jgates.js.password-min-length-below-8
  if (password.length < 6) throw new Error("short");
  // ruleid: jgates.js.password-min-length-below-8
  if (!(password.length >= 5)) throw new Error("short");
}
const joiLong = Joi.object({
  // ok: jgates.js.password-min-length-below-8
  password: Joi.string().min(12).required(),
});
const zodLong = z.object({
  // ok: jgates.js.password-min-length-below-8
  password: z.string().min(8),
  // ok: jgates.js.password-min-length-below-8
  username: z.string().min(3),
  // ok: jgates.js.password-min-length-below-8
  passwordMinLength: z.number().min(4),
});
const evOk = body("password").isLength({ min: 10 });
const mongooseOk = {
  // ok: jgates.js.password-min-length-below-8
  password: { type: String, minlength: 12 },
};
function checkLengthOk(password) {
  // ok: jgates.js.password-min-length-below-8
  if (password.length < 8) throw new Error("short");
  // ok: jgates.js.password-min-length-below-8
  if (password.length < 12) return false;
}
const lenFine = validator.isLength(password, { min: 8 });

// ---- password-max-length-below-64 ----
const joiCapped = Joi.object({
  // ruleid: jgates.js.password-max-length-below-64
  password: Joi.string().min(8).max(20),
});
const zodCapped = z.object({
  // ruleid: jgates.js.password-max-length-below-64
  password: z.string().min(8).max(32),
});
const mongooseCapped = {
  // ruleid: jgates.js.password-max-length-below-64
  password: { type: String, maxlength: 16 },
};
// ruleid: jgates.js.password-max-length-below-64
const evMax = body("password").isLength({ min: 8, max: 30 });
// ruleid: jgates.js.password-max-length-below-64
const lenCapped = validator.isLength(password, { max: 20 });
function checkMax(password) {
  // ruleid: jgates.js.password-max-length-below-64
  if (password.length > 20) throw new Error("long");
}
const joiRoomy = Joi.object({
  // ok: jgates.js.password-max-length-below-64
  password: Joi.string().min(8).max(128),
});
const zodRoomy = z.object({
  // ok: jgates.js.password-max-length-below-64
  password: z.string().min(8).max(64),
  // ok: jgates.js.password-max-length-below-64
  username: z.string().max(20),
});
const evMaxOk = body("password").isLength({ min: 8, max: 128 });
function checkMaxOk(password) {
  // ok: jgates.js.password-max-length-below-64
  if (password.length > 256) throw new Error("long");
}

// ---- password-composition-rule ----
// ruleid: jgates.js.password-composition-rule
const strong = validator.isStrongPassword(password, { minLength: 8, minUppercase: 1, minSymbols: 1 });
// ruleid: jgates.js.password-composition-rule
const schemaRule = new PasswordValidator().is().min(8).has().uppercase().has().digits(1);
const joiRule = Joi.object({
  // ruleid: jgates.js.password-composition-rule
  password: Joi.string().pattern(/^(?=.*[A-Z])(?=.*\d).{8,}$/),
});
// ruleid: jgates.js.password-composition-rule
const evRule = body("password").matches(/^(?=.*[a-z])(?=.*[A-Z]).{8,}$/);
// ok: jgates.js.password-composition-rule
const strongOk = validator.isStrongPassword(password, { minLength: 12, minUppercase: 0, minSymbols: 0 });
// ok: jgates.js.password-composition-rule
const schemaOk = new PasswordValidator().is().min(12).is().max(128).not().spaces();
const joiPlain = Joi.object({
  // ok: jgates.js.password-composition-rule
  password: Joi.string().min(12),
  // ok: jgates.js.password-composition-rule
  phone: Joi.string().pattern(/^(?=.*\d).{9,}$/),
});

// ---- password-transformed-before-verify ----
async function loginTransformed(password, hash) {
  // ruleid: jgates.js.password-transformed-before-verify
  const ok = await bcrypt.compare(password.toLowerCase(), hash);
  const cut = password.slice(0, 16);
  // ruleid: jgates.js.password-transformed-before-verify
  const digest = await argon2.hash(cut);
  // ruleid: jgates.js.password-transformed-before-verify
  const sha = crypto.createHash("sha256").update(password.toUpperCase()).digest("hex");
  return ok && digest && sha;
}
async function loginExact(password, email, hash) {
  // ok: jgates.js.password-transformed-before-verify
  const ok = await bcrypt.compare(password, hash);
  // ok: jgates.js.password-transformed-before-verify
  const other = await bcrypt.hash(email.toLowerCase(), 12);
  // ok: jgates.js.password-transformed-before-verify
  const digest = await argon2.hash(password);
  return ok && other && digest;
}

// ---- password-paste-blocked (DOM code) ----
const passwordInput = document.getElementById("password");
// ruleid: jgates.js.password-paste-blocked
passwordInput.addEventListener("paste", (e) => e.preventDefault());
// ruleid: jgates.js.password-paste-blocked
passwordInput.onpaste = () => false;
// ruleid: jgates.js.password-paste-blocked
$("#password").on("paste", function (e) { e.preventDefault(); });
// ruleid: jgates.js.password-paste-blocked
passwordInput.setAttribute("autocomplete", "off");
// ok: jgates.js.password-paste-blocked
passwordInput.addEventListener("paste", (e) => console.log(e.type));
// ok: jgates.js.password-paste-blocked
passwordInput.setAttribute("autocomplete", "current-password");
// ok: jgates.js.password-paste-blocked
document.getElementById("coupon").addEventListener("paste", (e) => e.preventDefault());

// ---- session-id-not-regenerated ----
function loginPlain(req, res, user) {
  // ruleid: jgates.js.session-id-not-regenerated
  req.session.userId = user.id;
  res.redirect("/");
}
const loginArrow = (req, res) => {
  // ruleid: jgates.js.session-id-not-regenerated
  req.session.isAuthenticated = true;
  res.sendStatus(204);
};
function loginRenewed(req, res, user) {
  req.session.regenerate((err) => {
    if (err) throw err;
    // ok: jgates.js.session-id-not-regenerated
    req.session.userId = user.id;
    res.redirect("/");
  });
}
function loginRenewedFirst(req, res, user) {
  req.session.regenerate(() => {});
  // ok: jgates.js.session-id-not-regenerated
  req.session.user = user.id;
}
function logout(req) {
  // ok: jgates.js.session-id-not-regenerated
  req.session.userId = null;
  // ok: jgates.js.session-id-not-regenerated
  req.session.theme = "dark";
}

// ---- client-controlled-privilege ----
function updateUser(req, user) {
  // ruleid: jgates.js.client-controlled-privilege
  user.role = req.body.role;
  // ruleid: jgates.js.client-controlled-privilege
  user.isAdmin = req.query.admin;
  const { permissions } = req.body;
  // ruleid: jgates.js.client-controlled-privilege
  user.permissions = permissions;
  // ok: jgates.js.client-controlled-privilege
  user.name = req.body.name;
  return user;
}
function createUser(req, db) {
  // ruleid: jgates.js.client-controlled-privilege
  return db.users.create({ email: req.body.email, role: req.body.role });
}
function safeUpdate(req, user, session) {
  // ok: jgates.js.client-controlled-privilege
  user.role = "member";
  // ok: jgates.js.client-controlled-privilege
  user.isAdmin = session.isAdmin;
  // ok: jgates.js.client-controlled-privilege
  return { email: req.body.email, role: "member" };
}

// ---- totp-window-too-wide ----
// ruleid: jgates.js.totp-window-too-wide
const spkWide = speakeasy.totp.verify({ secret, encoding: "base32", token, window: 10 });
// ruleid: jgates.js.totp-window-too-wide
const spkStep = speakeasy.totp({ secret, encoding: "base32", step: 120 });
// ruleid: jgates.js.totp-window-too-wide
authenticator.options = { window: 5 };
// ruleid: jgates.js.totp-window-too-wide
const totpPeriod = new OTPAuth.TOTP({ issuer: "app", secret, period: 90 });
// ok: jgates.js.totp-window-too-wide
const spkOk = speakeasy.totp.verify({ secret, encoding: "base32", token, window: 1 });
// ok: jgates.js.totp-window-too-wide
authenticator.options = { window: 1, step: 30 };
// ok: jgates.js.totp-window-too-wide
const totpOk = new OTPAuth.TOTP({ issuer: "app", secret, period: 30 });

// ---- secret-question-present ----
const profile = {
  // ruleid: jgates.js.secret-question-present
  secretQuestion: "First pet?",
  // ruleid: jgates.js.secret-question-present
  security_answer: "rex",
  // ok: jgates.js.secret-question-present
  question: "What is 2+2?",
};
function recover(user, body) {
  // ruleid: jgates.js.secret-question-present
  return user.securityAnswer === body.answer;
}
// ok: jgates.js.secret-question-present
const securityHeaders = { "x-frame-options": "DENY" };
