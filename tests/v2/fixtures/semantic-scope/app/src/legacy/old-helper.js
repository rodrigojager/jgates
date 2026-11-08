export function legacyTotal(orders) {
  return orders.reduce((sum, o) => sum + o.amount, 0);
}
