import * as fc from "fast-check";
import { absolute, add } from "./calc";

test("adds two numbers", () => {
  expect(add(2, 3)).toBe(5);
});

test("absolute value", () => {
  expect(absolute(-4)).toBe(4);
  expect(absolute(4)).toBe(4);
});

test("addition is commutative", () => {
  fc.assert(fc.property(fc.integer(), fc.integer(), (a, b) => add(a, b) === add(b, a)));
});
