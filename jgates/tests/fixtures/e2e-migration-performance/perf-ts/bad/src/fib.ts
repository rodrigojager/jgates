export function fib(n: number): number {
  const end = Date.now() + 20;
  while (Date.now() < end) {}
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}
