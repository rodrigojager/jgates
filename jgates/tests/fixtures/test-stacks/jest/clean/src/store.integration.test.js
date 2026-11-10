const { add } = require("./calc");

test("round trip through the store", () => {
  const store = new Map([["total", add(1, 2)]]);
  expect(store.get("total")).toBe(3);
});

test("sum of many values", () => {
  let total = 0;
  for (let value = 0; value < 5; value++) total = add(total, value);
  expect(total).toBe(10);
});
