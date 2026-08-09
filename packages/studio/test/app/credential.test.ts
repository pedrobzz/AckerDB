import { describe, expect, test } from "bun:test";
import {
  createStudioCredentialStore,
  STUDIO_CREDENTIAL_KEY,
  type StudioCredentialStorage,
} from "../../src/app/credential.ts";

function storage(seed?: string): StudioCredentialStorage & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  if (seed !== undefined) entries.set(STUDIO_CREDENTIAL_KEY, seed);
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

describe("the Studio credential cell", () => {
  test("a fresh cell holds nothing and its source is the anonymous credential", async () => {
    const store = createStudioCredentialStore(storage());
    expect(store.read()).toBeNull();
    expect(await store.source()).toEqual({ kind: "anonymous" });
  });

  test("a held credential is presented as a bearer, and survives a reload", async () => {
    const backing = storage();
    const store = createStudioCredentialStore(backing);
    store.write("ackerdb_credential.abc.def");
    expect(await store.source()).toEqual({ kind: "bearer", token: "ackerdb_credential.abc.def" });
    expect(backing.entries.get(STUDIO_CREDENTIAL_KEY)).toBe("ackerdb_credential.abc.def");

    const reloaded = createStudioCredentialStore(backing);
    expect(reloaded.read()).toBe("ackerdb_credential.abc.def");
  });

  test("an all-whitespace token is no credential, in either direction", async () => {
    const backing = storage("   ");
    expect(createStudioCredentialStore(backing).read()).toBeNull();

    const store = createStudioCredentialStore(storage());
    store.write("  padded  ");
    expect(store.read()).toBe("padded");
    store.write("\n\t ");
    expect(store.read()).toBeNull();
    expect(await store.source()).toEqual({ kind: "anonymous" });
  });

  test("forgetting the credential clears the backing storage", () => {
    const backing = storage("held");
    const store = createStudioCredentialStore(backing);
    store.write(null);
    expect(store.read()).toBeNull();
    expect(backing.entries.has(STUDIO_CREDENTIAL_KEY)).toBe(false);
  });

  test("subscribers see every change and no non-change", () => {
    const store = createStudioCredentialStore(storage());
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.write("one");
    store.write("one");
    store.write(" one ");
    store.write("two");
    expect(notifications).toBe(2);
    unsubscribe();
    store.write("three");
    expect(notifications).toBe(2);
  });

  test("a host without Web Storage gets a memory-only cell rather than a failure", async () => {
    const store = createStudioCredentialStore(null);
    store.write("held");
    expect(await store.source()).toEqual({ kind: "bearer", token: "held" });
    expect(createStudioCredentialStore(null).read()).toBeNull();
  });

  test("the source is bound at creation, so it can be handed over as a callback", async () => {
    const store = createStudioCredentialStore(storage("held"));
    const { source } = store;
    expect(await source()).toEqual({ kind: "bearer", token: "held" });
  });
});
