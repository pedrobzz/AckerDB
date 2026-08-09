/**
 * The Admin API's client contract: the typed reference tree for the
 * framework's own administration functions, and the shapes they answer with.
 *
 * **The framework's declarations are statically known, so they have no
 * business going through an application's code generation.** A group's tree is
 * generated from a walk of the *consumer's* functions directory, and a shipped
 * package has no such directory — so a package that only consumes the Admin
 * API could never obtain typed references that way, however the generator were
 * bent. Publishing the tree here, beside the reference builder that makes it,
 * gives every consumer the same one; generated `api.ts` re-exports it as the
 * `admin` binding, intersected with whatever the application itself published
 * into that group.
 *
 * The contract lives in core rather than in the server package that implements
 * it because core is what every client already depends on, and a browser
 * bundle has no business importing a server. The two are held together by a
 * compile-time proof on the server side, so a declaration that drifts from
 * this file fails the build rather than a caller.
 */
import { ADMIN_API_PATH, apiGroup, type MutationRef, type QueryRef } from "./refs.ts";

/**
 * What identifies one running application to an operator. Nothing else in the
 * protocol carries it: the welcome frame describes authentication, and a
 * client reached through a proxy sees the proxy's own origin, so this is the
 * one answer to "which application am I looking at, on which version".
 */
export interface AdminSystemInfo {
  /** The application's own name, as its package declares it. */
  readonly name: string;
  /** The application's own version, as its package declares it. */
  readonly version: string;
  /**
   * The AckerDB version serving it, which is also the whole of what it can
   * talk to: packages ship lockstep, so a consumer holding a different one is
   * a mixed install and every socket it opens is refused.
   */
  readonly ackerdb: string;
}

/** Arguments of a function that answers about the server and nothing else. */
export type AdminSystemInfoArgs = Record<never, never>;

/**
 * One Admin Credential, as an operator sees it. The secret is absent by
 * construction: only its digest is stored, so no read can return one, and the
 * plaintext exists solely in the answer of the call that issued it.
 */
export interface AdminCredential {
  /** The credential's public id — the first half of its bearer token. */
  readonly id: string;
  readonly name: string;
  /** Epoch milliseconds; with one master, this is what tells a rotation apart. */
  readonly createdAt: number;
}

/** Arguments of the calls that read and replace administrative authority. */
export type AdminCredentialsArgs = Record<never, never>;

/**
 * A freshly issued Admin Credential. `token` is the whole bearer, shown exactly
 * once: the call that produced it is marked non-replayable, so retrying it with
 * the same idempotency key answers with a receipt and never a second secret.
 */
export interface AdminCredentialIssued {
  readonly id: string;
  readonly token: string;
}

/**
 * The Admin API as a client addresses it. Every leaf is an ordinary function
 * reference, called through the ordinary client with a credential holding the
 * scope the declaration requires — there is no administrative transport and no
 * second stack.
 */
export interface AdminApi {
  readonly credentials: {
    readonly list: QueryRef<AdminCredentialsArgs, AdminCredential[]>;
    readonly rotate: MutationRef<AdminCredentialsArgs, AdminCredentialIssued>;
  };
  readonly system: {
    readonly info: QueryRef<AdminSystemInfoArgs, AdminSystemInfo>;
  };
}

/**
 * The Admin API's reference tree, identical in every application because the
 * framework declares it. Generated `api.ts` re-exports this as its `admin`
 * binding; a package with no code generation of its own imports it directly.
 */
export const adminApi: AdminApi = apiGroup(ADMIN_API_PATH) as AdminApi;
