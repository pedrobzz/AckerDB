/**
 * Where the Admin Credential lives while Studio is open.
 *
 * **Studio presents its credential through `credentialSource`, never through a
 * fixed `credential`.** The React provider's lifetime key includes a bearer
 * token, so a fixed credential makes signing in — and every later rotation —
 * close the client and construct a new one, dropping every live subscription
 * for a value the client is built to re-pull on its own. A source is pulled at
 * connect, ahead of the server-disclosed expiry, and after a rejection, so one
 * cell read by one callback is the whole mechanism.
 *
 * The cell is module-level rather than React state for the same reason: the
 * source is captured when a client lifetime starts and is never re-read from a
 * render. `sessionStorage` backs it so a reload does not ask again and closing
 * the tab forgets — an Admin Credential outliving the window it was typed into
 * is not a convenience. Nothing writes it to `localStorage`, to a cookie, or to
 * a URL: it is a bearer token for the whole application.
 */
import type { Credential } from "@ackerdb/core";

/** The `sessionStorage` key. Namespaced because Studio shares an origin with the application. */
export const STUDIO_CREDENTIAL_KEY = "ackerdb.studio.credential";

/** The slice of the Web Storage contract this store uses, and all of it. */
export interface StudioCredentialStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StudioCredentialStore {
  /** The credential currently held, or null when Studio has none. */
  readonly read: () => string | null;
  /** Hold a credential, or forget it. An all-whitespace token is no credential. */
  readonly write: (token: string | null) => void;
  /** React's external-store subscription; the form and the client share one cell. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The client's `credentialSource`: bound at creation, so it carries no `this`. */
  readonly source: () => Promise<Credential>;
}

const ANONYMOUS: Credential = Object.freeze({ kind: "anonymous" });

function normalize(token: string | null): string | null {
  if (token === null) return null;
  const trimmed = token.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * One credential cell over one storage. Storage is a constructor argument
 * rather than a global read so the store is exercised against a real
 * implementation off the browser; `null` gives a memory-only cell, which is
 * what a host without Web Storage honestly has.
 */
export function createStudioCredentialStore(
  storage: StudioCredentialStorage | null,
): StudioCredentialStore {
  let held = normalize(storage?.getItem(STUDIO_CREDENTIAL_KEY) ?? null);
  const listeners = new Set<() => void>();
  return {
    read: () => held,
    write: (token) => {
      const next = normalize(token);
      if (next === held) return;
      held = next;
      if (next === null) storage?.removeItem(STUDIO_CREDENTIAL_KEY);
      else storage?.setItem(STUDIO_CREDENTIAL_KEY, next);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Signed out is an explicit anonymous credential, not an absent one: the
    // client asks this source for every connection, and an anonymous answer is
    // what lets Studio stay connected and diagnose while nobody has signed in.
    source: () => Promise.resolve(held === null ? ANONYMOUS : { kind: "bearer", token: held }),
  };
}

function sessionStorageOrNull(): StudioCredentialStorage | null {
  return typeof sessionStorage === "undefined" ? null : sessionStorage;
}

/** The one cell the SPA reads: this tab's Admin Credential. */
export const studioCredential: StudioCredentialStore = createStudioCredentialStore(
  sessionStorageOrNull(),
);
