import type { CredentialVerifier } from "@dbzz/server";
import { verifyDemoCredential } from "./lib/token.ts";

const verifier = {
  revocationBound: { kind: "token-expiration" },
  verify: verifyDemoCredential,
  subscribeInvalidation: () => () => {},
} satisfies CredentialVerifier;

export default verifier;
