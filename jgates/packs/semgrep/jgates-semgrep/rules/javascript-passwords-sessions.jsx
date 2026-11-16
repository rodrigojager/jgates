import { useState } from "react";

export function LoginForm() {
  const [show, setShow] = useState(false);
  // ruleid: jgates.js.password-field-not-masked
  const plain = <input name="password" type="text" />;
  // ruleid: jgates.js.password-field-not-masked
  const email = <input id="newPassword" type="email" />;
  // ruleid: jgates.js.password-field-not-masked-by-default
  const missing = <input name="senha" />;
  // ruleid: jgates.js.password-field-not-masked-by-default
  const missingPassword = <input name="newPassword" autoComplete="new-password" />;
  // ok: jgates.js.password-field-not-masked, jgates.js.password-field-not-masked-by-default
  const masked = <input name="password" type="password" autoComplete="current-password" />;
  // ok: jgates.js.password-field-not-masked, jgates.js.password-field-not-masked-by-default
  const toggled = <input name="password" type={show ? "text" : "password"} />;
  // ok: jgates.js.password-field-not-masked-by-default
  const spread = <input name="password" {...passwordProps} />;
  // ok: jgates.js.password-field-not-masked
  const toggle = <input name="showPassword" type="checkbox" onChange={() => setShow(!show)} />;
  // ok: jgates.js.password-field-not-masked
  const user = <input name="username" type="text" />;
  return [plain, email, missing, missingPassword, masked, toggled, spread, toggle, user];
}

export function PasteForm() {
  // ruleid: jgates.js.password-paste-blocked
  const blocked = <input type="password" name="pw" onPaste={(e) => e.preventDefault()} />;
  // ruleid: jgates.js.password-paste-blocked
  const noManager = <input type="password" name="pw" autoComplete="off" />;
  // ok: jgates.js.password-paste-blocked
  const logged = <input type="password" name="pw" onPaste={(e) => console.log(e.type)} />;
  // ok: jgates.js.password-paste-blocked
  const managed = <input type="password" name="pw" autoComplete="new-password" />;
  // ok: jgates.js.password-paste-blocked
  const coupon = <input type="text" name="coupon" autoComplete="off" />;
  return [blocked, noManager, logged, managed, coupon];
}
