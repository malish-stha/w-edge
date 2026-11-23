/** Google Identity Services: renders the official "Sign in with Google" button. */

interface GoogleId {
  initialize(opts: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: "popup" }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
  disableAutoSelect(): void;
}
declare global {
  interface Window { google?: { accounts: { id: GoogleId } } }
}

let loading: Promise<GoogleId> | null = null;

function load(): Promise<GoogleId> {
  loading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google.accounts.id);
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error("Google sign-in failed to load."));
    script.onerror = () => { loading = null; reject(new Error("Google sign-in failed to load.")); };
    document.head.appendChild(script);
  });
  return loading;
}

export async function renderGoogleButton(el: HTMLElement, clientId: string, onCredential: (credential: string) => void) {
  const id = await load();
  id.initialize({ client_id: clientId, callback: (r) => onCredential(r.credential), ux_mode: "popup" });
  id.renderButton(el, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with", width: 280 });
}

export function googleSignOut() {
  window.google?.accounts?.id?.disableAutoSelect();
}
