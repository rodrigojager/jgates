const axios = require("axios");
const logger = require("./logger");

function logCredentials(req, user, password, apiToken, otp) {
  // ruleid: jgates.js.sensitive-data-logged
  console.log(password);
  // ruleid: jgates.js.sensitive-data-logged
  logger.info("login for " + user.name + " with " + password);
  // ruleid: jgates.js.sensitive-data-logged
  logger.warn(`retry with ${apiToken}`);
  // ruleid: jgates.js.sensitive-data-logged
  logger.debug({ user: user.id, password: req.body.password });
  // ruleid: jgates.js.sensitive-data-logged
  logger.error("denied", req.headers.authorization);
  // ruleid: jgates.js.sensitive-data-logged
  console.info({ otp });
  // ok: jgates.js.sensitive-data-logged
  logger.info("login for " + user.id);
  // ok: jgates.js.sensitive-data-logged
  logger.info({ user: user.id, password: "[redacted]" });
  // ok: jgates.js.sensitive-data-logged
  console.log("password reset requested", user.id);
  // ok: jgates.js.sensitive-data-logged
  logger.warn("token length", apiToken.length);
  // ok: jgates.js.sensitive-data-logged
  logger.debug({ tokenType: "bearer" });
}

function stackInResponse(app, koaApp) {
  app.get("/a", (req, res) => {
    try {
      run();
    } catch (err) {
      // ruleid: jgates.js.stack-trace-in-response
      res.status(500).send(err.stack);
    }
  });
  app.get("/b", (req, res) => {
    try {
      run();
    } catch (error) {
      // ruleid: jgates.js.stack-trace-in-response
      res.json({ ok: false, trace: error.stack });
    }
  });
  app.get("/c", (req, res) => {
    try {
      run();
    } catch (e) {
      // ok: jgates.js.stack-trace-in-response
      logger.error(e.stack);
      // ok: jgates.js.stack-trace-in-response
      res.status(500).json({ error: "internal error" });
    }
  });
  koaApp.use(async (ctx) => {
    try {
      run();
    } catch (err) {
      // ruleid: jgates.js.stack-trace-in-response-koa
      ctx.body = err.stack;
      // ruleid: jgates.js.stack-trace-in-response-koa
      ctx.body = { trace: err.stack };
      // ok: jgates.js.stack-trace-in-response-koa
      logger.error(err.stack);
      // ok: jgates.js.stack-trace-in-response-koa
      ctx.body = "internal error";
    }
  });
}

function messageInResponse(app) {
  app.get("/d", (req, res) => {
    try {
      run();
    } catch (err) {
      // ruleid: jgates.js.error-detail-in-response
      res.status(500).send(err.message);
    }
  });
  app.get("/e", (req, res) => {
    try {
      run();
    } catch (error) {
      // ruleid: jgates.js.error-detail-in-response
      res.json({ error: error.message });
    }
  });
  app.get("/f", (req, res) => {
    try {
      run();
    } catch (err) {
      // ok: jgates.js.error-detail-in-response
      logger.error(err.message);
      // ok: jgates.js.error-detail-in-response
      res.status(500).json({ error: "internal error" });
    }
  });
}

function swallowed(promise) {
  // ruleid: jgates.js.swallowed-exception
  try {
    run();
  } catch (err) {}
  // ruleid: jgates.js.swallowed-exception
  try {
    run();
  } catch {}
  // ruleid: jgates.js.swallowed-exception
  promise.catch(() => {});
  // ruleid: jgates.js.swallowed-exception
  promise.catch(function (err) {});
  // ok: jgates.js.swallowed-exception
  try {
    run();
  } catch (err) {
    logger.error(err);
  }
  // ok: jgates.js.swallowed-exception
  try {
    run();
  } catch (err) {
    throw err;
  }
  // ok: jgates.js.swallowed-exception
  promise.catch((err) => logger.error(err));
  // ok: jgates.js.swallowed-exception
  promise.catch((err) => {
    metrics.count("failed");
    throw err;
  });
}

async function outbound(url, body) {
  // ruleid: jgates.js.http-client-without-timeout
  await axios.get(url);
  // ruleid: jgates.js.http-client-without-timeout
  await axios.post(url, body, { headers: { "x-id": "1" } });
  // ruleid: jgates.js.http-client-without-timeout
  await axios({ url, method: "get" });
  // ok: jgates.js.http-client-without-timeout
  await axios.get(url, { timeout: 5000 });
  // ok: jgates.js.http-client-without-timeout
  await axios.post(url, body, { timeout: 5000 });
  // ok: jgates.js.http-client-without-timeout
  const client = axios.create({ timeout: 5000 });
  // ok: jgates.js.http-client-without-timeout
  await client.get(url);
}

async function redirectPolicy(req) {
  // ruleid: jgates.js.outbound-request-follows-redirects
  await fetch(req.query.url);
  const url = req.body.url;
  // ruleid: jgates.js.outbound-request-follows-redirects
  await axios.get(url, { timeout: 5000 });
  // ruleid: jgates.js.outbound-request-follows-redirects
  await axios.post(url, { report: true }, { timeout: 5000 });
  // ok: jgates.js.outbound-request-follows-redirects
  await fetch(req.query.url, { redirect: "error" });
  // ok: jgates.js.outbound-request-follows-redirects
  await fetch(req.query.url, { redirect: "manual" });
  // ok: jgates.js.outbound-request-follows-redirects
  await axios.get(url, { timeout: 5000, maxRedirects: 0 });
  // ok: jgates.js.outbound-request-follows-redirects
  await axios.post(url, { report: true }, { timeout: 5000, maxRedirects: 0 });
  // ok: jgates.js.outbound-request-follows-redirects
  await fetch("https://reports.example.com/daily");
}
