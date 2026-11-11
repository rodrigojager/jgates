import { test } from "vitest";
import { fib } from "./fib";

test("fib", async ({ bench }) => {
  await bench("fib(20)", { time: 300, iterations: 10 }, () => {
    fib(20);
  }).run();
});
