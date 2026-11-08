import { requireUser } from "../auth/guard.js";

export function me(req) {
  const user = requireUser(req);
  return { id: user.id, name: user.name };
}
