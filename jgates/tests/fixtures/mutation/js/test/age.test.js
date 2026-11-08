"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAdult, price } = require("../src/age.js");

// Weak suite: it never probes the boundary values 18 and 100.
test("an old person is an adult", () => assert.equal(isAdult(40), true));
test("a child is not an adult", () => assert.equal(isAdult(5), false));
test("a large order is discounted", () => assert.equal(price(200), 180));
test("a small order is not", () => assert.equal(price(50), 50));
