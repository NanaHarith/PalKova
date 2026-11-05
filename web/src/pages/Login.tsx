import { useState, type FormEvent } from "react";
import { AuthError, login } from "../api";

export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof AuthError ? "That password didn't work. Check it and try again." : "Can't reach the server. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <span className="wordmark">PalKova</span>
      <form onSubmit={submit} className="login-form">
        <h1>Kitchen board</h1>
        <label htmlFor="pw">Owner password</label>
        <input id="pw" type="password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} required autoFocus aria-invalid={!!error} aria-describedby="pw-error" />
        <p id="pw-error" className="error" role="alert">{error}</p>
        <button className="act act-paid" disabled={busy || !password}>{busy ? "Opening…" : "Open the board"}</button>
      </form>
    </main>
  );
}
