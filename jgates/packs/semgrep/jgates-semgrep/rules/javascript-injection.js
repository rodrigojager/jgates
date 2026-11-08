const child_process = require("child_process");
const { exec, execFile } = require("child_process");

function sql(db, name) {
  // ruleid: jgates.js.sql-string-building
  db.query(`SELECT * FROM users WHERE name = '${name}'`);
  // ruleid: jgates.js.sql-string-building
  db.query("SELECT * FROM users WHERE name = '" + name + "'");
  // ok: jgates.js.sql-string-building
  db.query("SELECT * FROM users WHERE name = $1", [name]);
}

function shell(host) {
  // ruleid: jgates.js.os-command-injection
  child_process.exec("ping " + host);
  // ruleid: jgates.js.os-command-injection
  exec(`ping ${host}`);
  // ok: jgates.js.os-command-injection
  execFile("ping", [host]);
  // ok: jgates.js.os-command-injection
  exec("uptime");
}

function dynamic(expression) {
  // ruleid: jgates.js.dynamic-code-execution
  eval(expression);
  // ruleid: jgates.js.dynamic-code-execution
  new Function(expression);
  // ok: jgates.js.dynamic-code-execution
  eval("1 + 1");
}
