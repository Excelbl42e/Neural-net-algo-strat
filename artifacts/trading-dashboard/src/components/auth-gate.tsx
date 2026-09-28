import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AUTH_REQUIRED_EVENT, fetchAuthStatus, postAuth, type AuthStatus } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Terminal } from "lucide-react";

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setStatus(await fetchAuthStatus()); setLoadError(null); }
    catch (e) { setLoadError(e instanceof Error ? e.message : "Cannot reach server"); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onAuth = () => setStatus((s) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuth);
  }, []);

  if (loadError) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4 text-sm">
        <div className="max-w-sm space-y-3 text-center">
          <p className="text-red-400">Cannot reach the server: {loadError}</p>
          <Button onClick={() => void refresh()}>Retry</Button>
        </div>
      </div>
    );
  }
  if (!status) return <div className="min-h-[100dvh] flex items-center justify-center text-muted-foreground text-sm">Loading…</div>;
  if (status.authenticated) return <>{children}</>;

  const setup = !status.ownerExists;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setup) {
      if (password.length < status.minPasswordLength) { setError(`Use at least ${status.minPasswordLength} characters`); return; }
      if (password !== confirm) { setError("Passwords do not match"); return; }
    }
    setBusy(true);
    const r = await postAuth(setup ? "setup" : "login", password);
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "Failed"); return; }
    setPassword(""); setConfirm("");
    await refresh();
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center p-4 bg-background">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2"><Terminal className="w-5 h-5 text-primary" /><span className="font-bold uppercase tracking-wider">NeuralTrade</span></div>
        <div>
          <h1 className="text-lg font-semibold">{setup ? "Choose your owner password" : "Log in"}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {setup ? "First launch. This protects your balances, trades and broker token. There is no reset link, so store it safely." : "Enter the owner password."}
          </p>
        </div>
        <Input type="password" autoFocus autoComplete={setup ? "new-password" : "current-password"} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-password" />
        {setup && <Input type="password" autoComplete="new-password" placeholder="Repeat password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || !password}>{busy ? "…" : setup ? "Create owner & log in" : "Log in"}</Button>
      </form>
    </div>
  );
}
