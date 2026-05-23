import { FormEvent, useState } from "react";
import { KeyRound, LockKeyhole } from "lucide-react";

interface AuthScreenProps {
  initialized: boolean;
  onAuthenticate: (password: string, setup: boolean) => Promise<void>;
}

export function AuthScreen({ initialized, onAuthenticate }: AuthScreenProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!initialized && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await onAuthenticate(password, !initialized);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-form" onSubmit={submit}>
        <div className="auth-title">
          <LockKeyhole size={28} />
          <div>
            <h1>Encodex</h1>
            <p>{initialized ? "Unlock workspace" : "Create secure workspace"}</p>
          </div>
        </div>
        <label className="form-field">
          App password
          <input autoFocus type="password" value={password} minLength={10} required onChange={(event) => setPassword(event.target.value)} />
        </label>
        {!initialized && (
          <label className="form-field">
            Confirm password
            <input type="password" value={confirmation} minLength={10} required onChange={(event) => setConfirmation(event.target.value)} />
          </label>
        )}
        {error && <p className="notice error">{error}</p>}
        <button className="primary command" type="submit" disabled={pending}>
          <KeyRound size={17} />
          {pending ? "Working..." : initialized ? "Unlock" : "Set Password"}
        </button>
      </form>
    </main>
  );
}
