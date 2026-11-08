// Shared authorization guard: every protected route calls it.
export function requireUser(req) {
  if (!req.user) {
    const error = new Error("unauthenticated");
    error.status = 401;
    throw error;
  }
  return req.user;
}

export function requireTenant(req, tenantId) {
  const user = requireUser(req);
  if (user.tenantId !== tenantId) {
    const error = new Error("forbidden");
    error.status = 403;
    throw error;
  }
  return user;
}
