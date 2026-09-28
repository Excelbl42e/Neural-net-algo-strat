export const AUTH_REQUIRED_EVENT = "neuraltrade.auth-required";

/** Any 401 from /api (except the auth endpoints) sends the user to the login screen. */
export function installAuthInterceptor(): void {
  if (typeof window === "undefined" || (window as unknown as { __ntAuth?: boolean }).__ntAuth) return;
  (window as unknown as { __ntAuth?: boolean }).__ntAuth = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, window.location.href).pathname;
    const res = await orig(input, { credentials: "same-origin", ...init });
    if (res.status === 401 && path.includes("/api/") && !path.includes("/api/auth/")) {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    }
    return res;
  };
}

export interface AuthStatus { ownerExists: boolean; authenticated: boolean; minPasswordLength: number }

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const r = await fetch("/api/auth/status", { cache: "no-store" });
  if (!r.ok) throw new Error(`Server returned ${r.status}`);
  return r.json();
}

export async function postAuth(path: "setup" | "login" | "logout", password?: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(password ? { password } : {}),
  });
  if (r.ok) return { ok: true };
  const body = await r.json().catch(() => ({}));
  return { ok: false, error: (body as { error?: string }).error ?? `Request failed (${r.status})` };
}
