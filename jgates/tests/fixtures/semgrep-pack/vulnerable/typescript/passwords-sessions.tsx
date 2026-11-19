export function SignupForm(): JSX.Element {
  return (
    <form>
      <input name="username" type="text" />
      <input name="password" type="text" />
      <input name="confirmPassword" />
      <input name="confirm" type="password" onPaste={(event: React.ClipboardEvent) => event.preventDefault()} />
    </form>
  );
}
