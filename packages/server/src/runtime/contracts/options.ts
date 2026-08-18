import type { CredentialVerifier, ScopeResolver } from "../../auth/credentials.ts";
import type { Registry } from "../../app/registry.ts";
import type { Engine } from "../../database/engine.ts";
import type { ServiceLimits } from "../limits.ts";
import type { RuntimeHooks } from "./lifecycle.ts";
import type { RuntimeFilesOptions } from "../../files/namespace.ts";

export interface RuntimeOptions {
  readonly engine: Engine;
  readonly registry: Registry;
  readonly verifier?: CredentialVerifier;
  /**
   * Resolves the grant patterns an Identity holds, re-read on every credential
   * verification and auth-epoch transition. Publish an account invalidation
   * when a grant changes, so live sessions re-authorize immediately.
   */
  readonly resolveScopes?: ScopeResolver;
  /** The application scope vocabulary (`defineApp({ scopes })`); absent when none. */
  readonly scopes?: readonly string[];
  readonly limits?: ServiceLimits;
  readonly hooks?: RuntimeHooks;
  /** Built-in immutable File storage and delivery configuration. */
  readonly files?: RuntimeFilesOptions;
  readonly now?: () => number;
}
