export function SignupForm() {
  return (
    <form>
      <input name="username" type="text" />
      <input name="password" type="text" />
      <input name="confirmPassword" />
      <input name="confirm" type="password" onPaste={(event) => event.preventDefault()} />
    </form>
  );
}
