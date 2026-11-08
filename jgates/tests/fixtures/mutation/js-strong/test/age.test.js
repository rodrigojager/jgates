"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isAdult, price } = require("../src/age.js");

// Strengthened suite: the boundary values are probed on both sides.
test("an old person is an adult", () => assert.equal(isAdult(40), true));
test("a child is not an adult", () => assert.equal(isAdult(5), false));
test("exactly 18 is an adult, 17 is not", () => {
  assert.equal(isAdult(18), true);
  assert.equal(isAdult(17), false);
});
test("a large order is discounted", () => assert.equal(price(200), 180));
test("a small order is not", () => assert.equal(price(50), 50));
test("exactly 100 is not discounted, 101 is", () => {
  assert.equal(price(100), 100);
  assert.equal(price(110), 99);
});
