/**
 * Identities and the external accounts that reach them, over the managed
 * Identity tables.
 *
 * An Identity is a durable number and nothing else, so this module is about the
 * mapping either side of it: which Identity a verified `(issuer, subject)` pair
 * resolves to, and which accounts one Identity answers to. Both directions are
 * indexed reads on ordinary managed tables — the same reader and writer every
 * other table uses, so an account link participates in the caller's transaction
 * and publishes the ordinary write keys.
 *
 * The one policy here is the final-account floor: unlinking the last account
 * would leave an Identity nobody can authenticate as, holding whatever the
 * application's own rows still say about it. That is refused, and the refusal is
 * the caller's to phrase.
 */
import type { Identity } from "@ackerdb/core";
import type { ExternalAccount } from "./credentials.ts";
import {
  IDENTITIES_TABLE,
  IDENTITY_ACCOUNTS_TABLE,
  type IdentityDatabase,
} from "./tables.ts";

/** What an unlink attempt resolved to; only `removed` changed anything. */
export type AccountDetachment = "removed" | "not_owned" | "last_account";

interface AccountRowRef {
  readonly issuer: { eq(value: string): unknown };
  readonly subject: { eq(value: string): unknown };
  readonly identity: { eq(value: Identity): unknown };
}

const ref = (row: never): AccountRowRef => row as unknown as AccountRowRef;

export class Identities {
  constructor(private readonly db: IdentityDatabase) {}

  /** Mint a fresh Identity. It is the caller's to attach a credential or an account to. */
  create(): PromiseLike<Identity> {
    return this.db[IDENTITIES_TABLE].insert({});
  }

  async exists(identity: Identity): Promise<boolean> {
    return await this.db[IDENTITIES_TABLE].get(identity) !== null;
  }

  /** The Identity one verified external account resolves to, or null. */
  async forAccount(issuer: string, subject: string): Promise<Identity | null> {
    const row = await this.accounts()
      .where((candidate) => ref(candidate).issuer.eq(issuer))
      .where((candidate) => ref(candidate).subject.eq(subject))
      .unique();
    return row === null ? null : row.identity;
  }

  /** Every external account one Identity answers to. */
  async accountsFor(identity: Identity): Promise<readonly ExternalAccount[]> {
    const rows = await this.accounts()
      .where((candidate) => ref(candidate).identity.eq(identity))
      .collect();
    return Object.freeze(rows.map((row) =>
      Object.freeze({ issuer: row.issuer, subject: row.subject })));
  }

  /** The Identity an account resolves to, minting one the first time it is seen. */
  async resolve(issuer: string, subject: string): Promise<Identity> {
    const existing = await this.forAccount(issuer, subject);
    if (existing !== null) return existing;
    const identity = await this.create();
    await this.db[IDENTITY_ACCOUNTS_TABLE].insert({ issuer, subject, identity });
    return identity;
  }

  /**
   * Link a verified account to an existing Identity. Linking what this Identity
   * already holds succeeds and writes nothing — proving the same account twice
   * is the same statement — while an account another Identity holds is refused,
   * because merging two Identities is not what a link was asked to do.
   */
  async attach(identity: Identity, issuer: string, subject: string): Promise<boolean> {
    const existing = await this.forAccount(issuer, subject);
    if (existing !== null) return existing === identity;
    await this.db[IDENTITY_ACCOUNTS_TABLE].insert({ issuer, subject, identity });
    return true;
  }

  /** Unlink an account this Identity owns, unless it is the only one left. */
  async detach(
    identity: Identity,
    issuer: string,
    subject: string,
  ): Promise<AccountDetachment> {
    const row = await this.accounts()
      .where((candidate) => ref(candidate).issuer.eq(issuer))
      .where((candidate) => ref(candidate).subject.eq(subject))
      .unique();
    if (row === null || row.identity !== identity) return "not_owned";
    const held = await this.accounts()
      .where((candidate) => ref(candidate).identity.eq(identity))
      .count();
    if (held <= 1) return "last_account";
    await this.db[IDENTITY_ACCOUNTS_TABLE].delete(row.id);
    return "removed";
  }

  private accounts() {
    return this.db[IDENTITY_ACCOUNTS_TABLE].query();
  }
}
