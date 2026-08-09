import { afterEach, describe, expect, test } from "bun:test";
import "ackerdb-test-support/dom";
import { ACKERDB_VERSION, type AdminSystemInfo } from "@ackerdb/core";
import { studioCredential } from "../../../src/app/credential.ts";
import { studioConnection } from "../../../src/app/connect/connection.ts";
import { ConnectScreen, type UnconnectedStudio } from "../../../src/app/connect/screen.tsx";
import { mountStudio, studioState, type MountedStudio } from "../../support/render.tsx";

const APPLICATION: AdminSystemInfo = {
  name: "savoria-eu",
  version: "2.1.0",
  ackerdb: ACKERDB_VERSION,
};

let mounted: MountedStudio | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  studioCredential.write(null);
});

function render(connection: UnconnectedStudio): HTMLElement {
  mounted = mountStudio(<ConnectScreen connection={connection} />);
  return mounted.container;
}

describe("the connect screen", () => {
  test("every unconnected state names itself where the launcher's tests can see it", () => {
    // #237 left `data-studio-state` behind as the affordance for whatever drew
    // these next. Restyling them is exactly the change that could drop it.
    const states: readonly UnconnectedStudio[] = [
      { state: "connecting" },
      { state: "unreachable", detail: "could not reach the application" },
      { state: "unconfigured" },
      { state: "refused", detail: "unauthorized" },
      { state: "session-failed", detail: "the Studio client was closed" },
    ];
    for (const connection of states) {
      const container = render(connection);
      expect(studioState(container)).toBe(connection.state);
      mounted?.unmount();
      mounted = undefined;
    }
  });

  test("a mixed install keeps naming the package to install", () => {
    // The whole value of this state is the instruction. A restyle that
    // flattened it into a generic failure would leave an operator with a
    // working credential and no idea which Studio to install, which is the one
    // thing this screen exists to prevent.
    const older: AdminSystemInfo = { ...APPLICATION, ackerdb: "0.16.0" };
    const connection = studioConnection({
      hasCredential: true,
      probe: { status: "open", application: older },
      authentication: { phase: "failed", error: { message: "internal error" } as never },
    }) as UnconnectedStudio;

    const text = render(connection).textContent ?? "";
    expect(text).toContain("this application runs AckerDB 0.16.0");
    expect(text).toContain(`this Studio is ${ACKERDB_VERSION}`);
    expect(text).toContain("install @ackerdb/studio@0.16.0");
  });

  test("only the two states a credential can fix offer the field", () => {
    for (const connection of [{ state: "unconfigured" } as const, { state: "refused", detail: "no" } as const]) {
      const container = render(connection);
      expect(container.querySelector("#studio-credential")).not.toBeNull();
      mounted?.unmount();
      mounted = undefined;
    }
    // Unreachable offers none: Studio is up and the application is not, so a
    // field would imply that typing something could help.
    const container = render({ state: "unreachable", detail: "down" });
    expect(container.querySelector("#studio-credential")).toBeNull();
  });

  test("the submit is the form's own last child, never the field's neighbour", () => {
    // Both credential states put the same control in the same place, so its
    // hit target has to be unambiguous: the form is a column whose last child
    // is the button, and the field sits a level deeper with its label. This is
    // the structural half of the claim — the browser run in the pull request
    // is what measures the pixels, because happy-dom has no layout at all.
    const container = render({ state: "unconfigured" });
    const form = container.querySelector("form")!;
    expect(form.lastElementChild).toBe(container.querySelector("button[type=submit]"));
    expect(container.querySelector("#studio-credential")!.parentElement).not.toBe(form);
  });

  test("the field cannot hand the credential to the browser or the document", () => {
    // The credential is a bearer for the whole application. A field that
    // autocompletes it, spell-checks it, or renders it as text is a field that
    // leaks it somewhere nobody looked.
    const container = render({ state: "unconfigured" });
    const input = container.querySelector<HTMLInputElement>("#studio-credential")!;
    // Read as attributes: happy-dom does not reflect either of these onto the
    // property, so the property form would assert nothing.
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    // The field is born empty and is never rendered from a stored value, so
    // the serialized document has no token in it to begin with.
    expect(input.getAttribute("value") ?? "").toBe("");
    expect(mounted!.container.innerHTML).not.toContain("ackerdb_credential.");
  });

  test("no state puts a field for the server's address on the screen", () => {
    // Studio talks to its own origin and `acker studio` owns the target. A
    // second way to point Studio somewhere would put an Admin Credential one
    // typo away from an origin nobody chose.
    for (const connection of [
      { state: "unconfigured" } as const,
      { state: "refused", detail: "no" } as const,
      { state: "unreachable", detail: "down" } as const,
    ]) {
      const container = render(connection);
      const fields = [...container.querySelectorAll("input")].map((input) => input.id);
      expect(fields.filter((id) => id !== "studio-credential")).toEqual([]);
      mounted?.unmount();
      mounted = undefined;
    }
  });
});
