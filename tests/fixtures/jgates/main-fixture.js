"use strict";

// Main JGates fixture: a minimal Python + TypeScript monorepo built in a temp dir.
//
// API (CommonJS):
//   MIN_API_COVERAGE                 minimum line coverage (percent) the API must reach
//   createMainFixture() -> { dir, brokenCommit }   git repo with one commit holding two planted violations
//   fixMainFixture(dir) -> fixedCommit             removes both violations, makes a new commit
//   measureApiCoverage(dir) -> { percent, covered, total, tests_ok }   stdlib-only (needs `python` on PATH)
//   findDomainInfraImports(dir) -> string[]        domain files importing the infrastructure layer
//   listTree(dir) -> { relPath: content }          every file outside .git, for byte comparisons
//   removeFixture(dir)
// Components: web/ (TypeScript), api/ (Python: domain, application, infrastructure), libs/shared/ (TypeScript).
// Commits are deterministic (fixed author, dates and message), so equal trees give equal commits.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MIN_API_COVERAGE = 80;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
};

const API = "api/src/shop_api";

const json = (value) => JSON.stringify(value, null, 2) + "\n";
const tsconfig = json({
  compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", outDir: "dist" },
  include: ["src"]
});

const COMMON = {
  "README.md": "# Shop monorepo (test fixture)\n",
  ".gitignore": "__pycache__/\nnode_modules/\ndist/\n",
  "web/package.json": json({ name: "shop-web", version: "0.1.0", private: true, scripts: { build: "tsc -p ." } }),
  "web/tsconfig.json": tsconfig,
  "web/src/index.ts":
    'import { formatPrice } from "../../libs/shared/src/format.js";\n\nexport function renderTotal(cents: number): string {\n  return `Total: ${formatPrice(cents)}`;\n}\n',
  "libs/shared/package.json": json({ name: "shop-shared", version: "0.1.0", private: true }),
  "libs/shared/tsconfig.json": tsconfig,
  "libs/shared/src/format.ts": "export function formatPrice(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n",
  "api/pyproject.toml":
    '[project]\nname = "shop-api"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n\n[tool.setuptools.packages.find]\nwhere = ["src"]\n',
  [`${API}/__init__.py`]: "",
  [`${API}/domain/__init__.py`]: "",
  [`${API}/infrastructure/__init__.py`]: "",
  [`${API}/application/__init__.py`]: "",
  [`${API}/infrastructure/repository.py`]:
    "class InMemoryRepository:\n    def __init__(self):\n        self._items = {}\n\n    def save(self, key, value):\n        self._items[key] = value\n\n    def load(self, key):\n        return self._items.get(key)\n",
  [`${API}/application/place_order.py`]:
    "from shop_api.domain.order import Order\n\n\ndef place_order(repository, order_id, cents):\n    order = Order(order_id, cents)\n    repository.save(order_id, order)\n    return order\n",
  "api/tests/__init__.py": ""
};

const BROKEN = {
  // Violation 1: the domain imports the infrastructure layer.
  [`${API}/domain/order.py`]:
    "from shop_api.infrastructure.repository import InMemoryRepository\n\n\nclass Order:\n    def __init__(self, order_id, cents):\n        self.order_id = order_id\n        self.cents = cents\n\n    def total(self):\n        return self.cents\n\n\ndef default_repository():\n    return InMemoryRepository()\n",
  // Violation 2: refunds has no tests, so line coverage stays under the minimum.
  [`${API}/application/refunds.py`]:
    'def refund_amount(cents, percent):\n    if percent < 0 or percent > 100:\n        raise ValueError("invalid percent")\n    return cents * percent // 100\n\n\ndef refund_label(cents, percent):\n    amount = refund_amount(cents, percent)\n    if amount == 0:\n        return "nothing"\n    if amount == cents:\n        return "full"\n    return "partial"\n\n\ndef refund_batch(items):\n    results = []\n    for cents, percent in items:\n        results.append(refund_label(cents, percent))\n    return results\n',
  "api/tests/test_orders.py":
    'import unittest\n\nfrom shop_api.application.place_order import place_order\nfrom shop_api.infrastructure.repository import InMemoryRepository\n\n\nclass PlaceOrderTest(unittest.TestCase):\n    def test_place_order_saves(self):\n        repo = InMemoryRepository()\n        order = place_order(repo, "o1", 500)\n        self.assertEqual(repo.load("o1"), order)\n        self.assertEqual(order.total(), 500)\n\n\nif __name__ == "__main__":\n    unittest.main()\n'
};

const FIXED = {
  [`${API}/domain/order.py`]:
    "class Order:\n    def __init__(self, order_id, cents):\n        self.order_id = order_id\n        self.cents = cents\n\n    def total(self):\n        return self.cents\n",
  "api/tests/test_refunds.py":
    'import unittest\n\nfrom shop_api.application.refunds import refund_amount, refund_batch, refund_label\n\n\nclass RefundTest(unittest.TestCase):\n    def test_amount(self):\n        self.assertEqual(refund_amount(200, 50), 100)\n        with self.assertRaises(ValueError):\n            refund_amount(200, 101)\n\n    def test_labels(self):\n        self.assertEqual(refund_label(200, 0), "nothing")\n        self.assertEqual(refund_label(200, 100), "full")\n        self.assertEqual(refund_label(200, 50), "partial")\n\n    def test_batch(self):\n        self.assertEqual(refund_batch([(200, 100), (200, 0)]), ["full", "nothing"])\n\n\nif __name__ == "__main__":\n    unittest.main()\n'
};

function git(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: Object.assign({}, process.env, GIT_ENV) });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function createMainFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-main-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.name", "Fixture"]);
    git(dir, ["config", "user.email", "fixture@example.invalid"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    writeFiles(dir, Object.assign({}, COMMON, BROKEN));
    return { dir, brokenCommit: commitAll(dir, "Add shop monorepo fixture") };
  } catch (error) {
    removeFixture(dir);
    throw error;
  }
}

function fixMainFixture(dir) {
  writeFiles(dir, FIXED);
  return commitAll(dir, "Fix domain import and add refund tests");
}

function measureApiCoverage(dir) {
  const script = path.join(__dirname, "measure_coverage.py");
  const result = spawnSync("python", ["-B", script, path.join(dir, "api")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`coverage run failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function walk(dir, base, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "__pycache__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out[path.relative(base, full).split(path.sep).join("/")] = fs.readFileSync(full).toString("latin1");
  }
  return out;
}

function listTree(dir) {
  return walk(dir, dir, {});
}

function findDomainInfraImports(dir) {
  const tree = listTree(dir);
  return Object.keys(tree).filter(
    (rel) =>
      rel.startsWith(`${API}/domain/`) &&
      rel.endsWith(".py") &&
      /^\s*(from|import)\s+shop_api\.infrastructure\b/m.test(tree[rel])
  );
}

function removeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  MIN_API_COVERAGE,
  createMainFixture,
  fixMainFixture,
  measureApiCoverage,
  findDomainInfraImports,
  listTree,
  removeFixture
};
