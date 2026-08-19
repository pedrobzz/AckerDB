import { SignJWT, jwtVerify } from "jose";
import { AckerDBError, type VerifiedUserCredential } from "@ackerdb/server";
import { emailInput, guestNameInput } from "./inputs.ts";

const ISSUER = "https://demo.ackerdb.local/";
const AUDIENCE = "ackerdb-demo";
const GUEST_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const secret = new TextEncoder().encode(
  process.env.ACKERDB_DEMO_SIGNING_SECRET ??
    "ackerdb-demo-local-signing-secret-change-me",
);

export interface GuestTokenResult {
  token: string;
  expiresAt: number;
  name: string;
  email: string;
}

export async function issueGuestToken(input: {
  name: string;
  email: string;
}): Promise<GuestTokenResult> {
  const name = input.name;
  const email = input.email.toLowerCase();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const expiresAtSeconds = nowSeconds + GUEST_TOKEN_LIFETIME_SECONDS;
  const token = await new SignJWT({ role: "guest", email, name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(`guest:${email}`)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAtSeconds)
    .setJti(crypto.randomUUID())
    .sign(secret);
  return { token, expiresAt: expiresAtSeconds * 1_000, name, email };
}

export async function verifyDemoCredential(
  credential: string,
): Promise<VerifiedUserCredential> {
  const staffToken = process.env.ACKERDB_DEMO_STAFF_TOKEN ?? "savoria-demo-staff";
  if (credential === staffToken) {
    // Staff authenticate as a user-kind principal so the whole team shares one
    // durable Identity (subject "staff:amelia"). Owner-token administration is
    // restricted to external user identities, so this is what lets staff manage
    // the Admin MCP's owner tokens.
    return {
      kind: "user",
      issuer: ISSUER,
      subject: "staff:amelia",
      claims: { role: "staff", name: "Amelia Morgan" },
      expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
      tokenId: null,
    };
  }

  try {
    const { payload } = await jwtVerify(credential, secret, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      typ: "JWT",
    });
    if (
      payload.role !== "guest" ||
      typeof payload.sub !== "string" ||
      !payload.sub.startsWith("guest:") ||
      typeof payload.email !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.exp !== "number"
    ) {
      throw new Error("invalid guest claims");
    }
    const email = emailInput.parse(payload.email, "credential.email").toLowerCase();
    const name = guestNameInput.parse(payload.name, "credential.name");
    if (payload.sub !== `guest:${email}`)
      throw new Error("subject does not match email");
    return {
      kind: "user",
      issuer: ISSUER,
      subject: payload.sub,
      claims: { role: "guest", email, name },
      expiresAt: payload.exp * 1_000,
      tokenId: typeof payload.jti === "string" ? payload.jti : null,
    };
  } catch {
    throw new AckerDBError("unauthenticated", "Invalid demo credential");
  }
}
