import { requireTenant } from "../auth/guard.js";

export function listOrders(req, db) {
  const user = requireTenant(req, req.params.tenantId);
  return db.orders.filter((o) => o.tenantId === user.tenantId);
}
