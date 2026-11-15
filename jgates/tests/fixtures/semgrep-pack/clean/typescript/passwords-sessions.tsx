export function SignupForm(): JSX.Element {
  return (
    <form>
      <input name="username" type="text" />
      <input name="password" type="password" autoComplete="new-password" />
      <input name="confirm" type="password" autoComplete="new-password" />
    </form>
  );
}
