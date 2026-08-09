import { afterEach, describe, expect, test } from "bun:test";
import "ackerdb-test-support/dom";
import { studioCredential } from "../../src/app/credential.ts";
import { useStudioSession, type StudioSession } from "../../src/app/session.ts";
import { mountStudio, type MountedStudio } from "../support/render.tsx";

let mounted: MountedStudio | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  studioCredential.write(null);
});

/** Hands the hook's result to the test, which then drives it as the screen does. */
function session(): StudioSession {
  let latest!: StudioSession;
  function Probe() {
    latest = useStudioSession();
    return null;
  }
  mounted = mountStudio(<Probe />);
  return latest;
}

describe("signing Studio in and out", () => {
  test("signing in fills the cell the credential source reads", async () => {
    // The order is the whole rule: the source is pulled when the client is
    // asked to refresh, so a cell written afterwards would hand it the value it
    // already had. This is the half of the connect form that is not appearance,
    // and the pull request drives the rest through a real browser.
    const { signIn } = session();
    expect(studioCredential.read()).toBeNull();

    mounted?.flush(() => signIn("ackerdb_credential.abc.def"));

    expect(studioCredential.read()).toBe("ackerdb_credential.abc.def");
    expect(await studioCredential.source()).toEqual({
      kind: "bearer",
      token: "ackerdb_credential.abc.def",
    });
  });

  test("forgetting empties it, and the source says anonymous rather than nothing", async () => {
    // An absent credential is still an answer. The client asks the source for
    // every connection, and anonymous is what lets Studio stay connected and
    // keep diagnosing while nobody is signed in.
    studioCredential.write("held");
    const { forget } = session();

    mounted?.flush(() => forget());

    expect(studioCredential.read()).toBeNull();
    expect(await studioCredential.source()).toEqual({ kind: "anonymous" });
  });

  test("a credential of whitespace is no credential", () => {
    const { signIn } = session();
    mounted?.flush(() => signIn("   \n\t "));
    expect(studioCredential.read()).toBeNull();
  });
});
