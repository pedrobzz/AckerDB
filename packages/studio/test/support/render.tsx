/**
 * Mounting a piece of Studio the way the browser does.
 *
 * The screens all sit under an `AckerDBProvider`, and several of them read the
 * client's authentication phase, so a bare `createRoot` renders nothing they
 * would recognise. The provider here is given a socket that never opens: every
 * component under test in this suite decides what it draws from a prop or from
 * the credential cell, and a socket that answers would only add a second thing
 * that could move between an assertion and the render it describes.
 *
 * The credential source is the real module-level cell, because the point of
 * several of these tests is that submitting the form is what fills it.
 */
import { AckerDBProvider } from "@ackerdb/client-react";
import { FakeSocket, ManualClock } from "ackerdb-test-support/client-transport";
import { actEnvironment, mountPoint } from "ackerdb-test-support/dom";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { studioCredential } from "../../src/app/credential.ts";

export interface MountedStudio {
  readonly container: HTMLElement;
  /** Run something that changes state, then let React commit it. */
  readonly flush: (work?: () => void) => void;
  /**
   * Let work that resolves a promise commit. The router settles its first
   * match asynchronously, so a tree containing one renders nothing at all
   * until this has run — a synchronous flush sees an empty document and reads
   * as a component that rendered nothing.
   */
  readonly settle: () => Promise<void>;
  readonly unmount: () => void;
}

export function mountStudio(children: ReactNode): MountedStudio {
  actEnvironment(true);
  const container = mountPoint();
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <StrictMode>
        <AckerDBProvider
          config={{
            url: "http://studio.test",
            clientSessionId: "studio-test",
            clock: new ManualClock(),
            random: () => 0,
            createWebSocket: () => new FakeSocket(),
            credentialSource: studioCredential.source,
          }}
        >
          {children}
        </AckerDBProvider>
      </StrictMode>,
    );
  });
  return {
    container,
    flush: (work) => {
      act(() => {
        work?.();
      });
    },
    settle: async () => {
      await act(async () => {
        await Promise.resolve();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      actEnvironment(false);
    },
  };
}

/** The one element naming the connect state, which is the screens' own contract. */
export function studioState(container: HTMLElement): string | null {
  return container.querySelector("[data-studio-state]")?.getAttribute("data-studio-state") ?? null;
}

/**
 * **Typing cannot be simulated in this environment, and the reason is worth
 * recording so the next reader does not spend an afternoon on it.**
 *
 * React delivers `onChange` for a text field from the `input` event plus its
 * own value tracker, and under happy-dom both halves are demonstrably right —
 * the event bubbles to the React root, and driving the prototype's `value`
 * setter leaves `input.value` and the tracker disagreeing, which is exactly
 * the mismatch React looks for. `onChange` still never fires, while `onClick`
 * on the same tree does. So the whole submit path is exercised against a real
 * browser and a real server instead (see the pull request), and these suites
 * assert what a DOM without layout or a change pipeline can honestly answer:
 * which state renders, what it says, and what it offers.
 *
 * Two more of happy-dom's answers are wrong outright and should not be built
 * on: `Node.contains` and `Element.closest` both fail for a genuine
 * descendant. `parentElement` and `lastElementChild` are sound.
 */
export const TYPING_IS_NOT_SIMULATED = true;
