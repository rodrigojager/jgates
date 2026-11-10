const { add } = require("./calc");

test("adds two numbers", () => {
  expect(add(2, 2)).toBe(5);
});

test("adds zero", () => {
  expect(add(7, 0)).toBe(7);
});
