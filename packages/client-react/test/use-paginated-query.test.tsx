import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actEnvironment, mountPoint } from "./support/dom.ts";
import { createHarness, type ProviderHarness } from "./support/harness.ts";
import {
  MAX_PAGE_SIZE,
  PROTOCOL_VERSION,
  type ApplicationError,
  type QueryPage,
  type ServerMessage,
  type SubscriptionCursor,
} from "@ackerdb/core";
import type { QueryRef } from "@ackerdb/client";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  AckerDBProvider,
  skip,
  usePaginatedQuery,
  type AckerDBPaginatedQueryState,
} from "@ackerdb/client-react";

const SESSION = "use-paginated-query-session";
const APP = { url: "http://use-paginated-query.test", clientSessionId: SESSION };

type LogArgs = {
  readonly list: bigint;
  readonly cursor: string | null;
  readonly pageSize: number;
};
type LogsGone = ApplicationError<"logs.gone", { readonly list: bigint }, 410>;
const logs = { $ref: "api.logs.list" } as QueryRef<LogArgs, QueryPage<string>, LogsGone>;

function cursor(commitVersion: bigint, identity: string): SubscriptionCursor {
  return { generation: "generation-1", commitVersion, authEpoch: 0, identity };
}

let observed: AckerDBPaginatedQueryState<string, LogsGone> | undefined;

function describeState(state: AckerDBPaginatedQueryState<string, LogsGone>): string {
  const window = state.items === undefined ? "-" : state.items.join(",");
  const suffix = `${state.loadingMore ? "+more" : ""}${state.exhausted ? "+end" : ""}`;
  switch (state.status) {
    case "disabled":
    case "pending":
      return state.status;
    case "success":
      return `fresh:${window}${suffix}`;
    case "application-error":
      return `application-error:${state.error.code}`;
    case "rejected":
      return `rejected:${state.error.code}`;
    case "unavailable":
      return state.items === undefined
        ? `error:${state.error.code}`
        : `stale:${window}${suffix}`;
  }
}

function Report({
  args,
  pageSize,
}: {
  args: { readonly list: bigint } | typeof skip;
  pageSize?: number;
}): ReactNode {
  const state = usePaginatedQuery(logs, args, pageSize === undefined ? undefined : { pageSize });
  observed = state;
  return <span>{describeState(state)}</span>;
}

async function render(root: Root, element: ReactNode): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function app(
  harness: ProviderHarness,
  args: { readonly list: bigint } | typeof skip,
  pageSize?: number,
): ReactNode {
  return (
    <AckerDBProvider config={harness.config()}>
      <Report args={args} pageSize={pageSize} />
    </AckerDBProvider>
  );
}

async function receive(harness: ProviderHarness, frame: ServerMessage): Promise<void> {
  await act(async () => {
    harness.live().receive(frame);
  });
}

async function ready(harness: ProviderHarness): Promise<void> {
  await act(async () => {
    harness.live().welcome(SESSION);
  });
}

async function deliverPage(
  harness: ProviderHarness,
  id: number,
  commitVersion: bigint,
  page: QueryPage<string>,
): Promise<void> {
  await receive(harness, {
    v: PROTOCOL_VERSION,
    t: "transition",
    id,
    transition: {
      kind: "reset",
      from: null,
      to: cursor(commitVersion, `api.logs.list:${id}`),
      value: page,
    },
  });
}

async function loadMore(): Promise<void> {
  await act(async () => {
    observed!.loadMore();
  });
}

beforeAll(() => actEnvironment(true));
afterAll(() => actEnvironment(false));

describe("usePaginatedQuery", () => {
  test("subscribes one live page at a time and chains cursors through loadMore", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, skip));
    expect(container.textContent).toBe("disabled");
    await ready(harness);
    expect(harness.frames("sub")).toHaveLength(0);

    await render(root, app(harness, { list: 1n }, 2));
    expect(container.textContent).toBe("pending");
    const first = harness.frames("sub")[0]!;
    expect(first.ref).toBe("api.logs.list");
    expect(first.args).toEqual({ list: 1n, cursor: null, pageSize: 2 });

    await deliverPage(harness, first.id, 1n, { items: ["a", "b"], nextCursor: "c1" });
    expect(container.textContent).toBe("fresh:a,b");
    expect(harness.frames("sub")).toHaveLength(1);

    await loadMore();
    expect(container.textContent).toBe("fresh:a,b+more");
    const second = harness.frames("sub")[1]!;
    expect(second.args).toEqual({ list: 1n, cursor: "c1", pageSize: 2 });

    await deliverPage(harness, second.id, 1n, { items: ["c"], nextCursor: null });
    expect(container.textContent).toBe("fresh:a,b,c+end");

    // Exhausted: loadMore is a no-op.
    await loadMore();
    expect(harness.frames("sub")).toHaveLength(2);

    await act(async () => {
      root.unmount();
    });
  });

  test("defaults to 25 rows per page", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, { list: 7n }));
    await ready(harness);
    expect(harness.frames("sub")[0]!.args).toEqual({ list: 7n, cursor: null, pageSize: 25 });

    await act(async () => {
      root.unmount();
    });
  });

  test("a page size the server would reject fails immediately, at the hook", () => {
    for (const pageSize of [0, -1, 1.5, Number.NaN, MAX_PAGE_SIZE + 1]) {
      expect(() => renderToString(app(createHarness(APP), { list: 1n }, pageSize))).toThrow(
        RangeError,
      );
    }
  });

  test("a page-one boundary shift resubscribes the pages behind it", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, { list: 1n }, 2));
    await ready(harness);
    const first = harness.frames("sub")[0]!;
    await deliverPage(harness, first.id, 1n, { items: ["a", "b"], nextCursor: "c1" });
    await loadMore();
    const second = harness.frames("sub")[1]!;
    await deliverPage(harness, second.id, 1n, { items: ["c"], nextCursor: null });
    expect(container.textContent).toBe("fresh:a,b,c+end");

    // A write lands inside page one: its window shifts and ends elsewhere.
    await deliverPage(harness, first.id, 2n, { items: ["z", "a"], nextCursor: "c1'" });
    // The old page two no longer starts at page one's boundary, so it is
    // replaced and the window truncates to the prefix it can still prove.
    expect(container.textContent).toBe("fresh:z,a+more");
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([second.id]);
    const repaired = harness.frames("sub")[2]!;
    expect(repaired.args).toEqual({ list: 1n, cursor: "c1'", pageSize: 2 });

    await deliverPage(harness, repaired.id, 2n, { items: ["b", "c"], nextCursor: null });
    expect(container.textContent).toBe("fresh:z,a,b,c+end");

    await act(async () => {
      root.unmount();
    });
  });

  test("a boundary shift releases the whole suffix, then regrows to the asked depth", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, { list: 1n }, 2));
    await ready(harness);
    const first = harness.frames("sub")[0]!;
    await deliverPage(harness, first.id, 1n, { items: ["a", "b"], nextCursor: "c1" });
    await loadMore();
    const second = harness.frames("sub")[1]!;
    await deliverPage(harness, second.id, 1n, { items: ["c", "d"], nextCursor: "c2" });
    await loadMore();
    const third = harness.frames("sub")[2]!;
    await deliverPage(harness, third.id, 1n, { items: ["e"], nextCursor: null });
    expect(container.textContent).toBe("fresh:a,b,c,d,e+end");

    // Page one's boundary moves. Everything behind it started at a boundary
    // that no longer exists, so it is released now — not once the replacement
    // resolves, which it may never do.
    await deliverPage(harness, first.id, 2n, { items: ["z", "a"], nextCursor: "c1'" });
    expect(harness.frames("unsub").map((frame) => frame.id).sort()).toEqual(
      [second.id, third.id].sort(),
    );
    expect(container.textContent).toBe("fresh:z,a+more");
    const repairedSecond = harness.frames("sub")[3]!;
    expect(repairedSecond.args).toEqual({ list: 1n, cursor: "c1'", pageSize: 2 });
    expect(harness.frames("sub")).toHaveLength(4);

    // The depth someone clicked for survives the release: page three comes
    // back on its own as soon as its boundary is proven again.
    await deliverPage(harness, repairedSecond.id, 2n, { items: ["b", "c"], nextCursor: "c2'" });
    const repairedThird = harness.frames("sub")[4]!;
    expect(repairedThird.args).toEqual({ list: 1n, cursor: "c2'", pageSize: 2 });
    await deliverPage(harness, repairedThird.id, 2n, { items: ["d", "e"], nextCursor: null });
    expect(container.textContent).toBe("fresh:z,a,b,c,d,e+end");

    await act(async () => {
      root.unmount();
    });
  });

  test("a shrunken window drops the pages past its new end", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, { list: 1n }, 2));
    await ready(harness);
    const first = harness.frames("sub")[0]!;
    await deliverPage(harness, first.id, 1n, { items: ["a", "b"], nextCursor: "c1" });
    await loadMore();
    const second = harness.frames("sub")[1]!;
    await deliverPage(harness, second.id, 1n, { items: ["c"], nextCursor: null });

    await deliverPage(harness, first.id, 2n, { items: ["a"], nextCursor: null });
    expect(container.textContent).toBe("fresh:a+end");
    expect(harness.frames("unsub").map((frame) => frame.id)).toEqual([second.id]);

    await act(async () => {
      root.unmount();
    });
  });

  test("Strict Mode leaves exactly one live subscription per page", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, <StrictMode>{app(harness, { list: 1n }, 2)}</StrictMode>);
    await ready(harness);
    expect(harness.frames("sub")).toHaveLength(1);
    const first = harness.frames("sub")[0]!;
    await deliverPage(harness, first.id, 1n, { items: ["a", "b"], nextCursor: "c1" });
    expect(container.textContent).toBe("fresh:a,b");
    await loadMore();
    expect(harness.frames("sub")).toHaveLength(2);
    expect(harness.frames("unsub")).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  test("unmounting releases every page subscription", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, { list: 1n }, 2));
    await ready(harness);
    const first = harness.frames("sub")[0]!;
    await deliverPage(harness, first.id, 1n, { items: ["a", "b"], nextCursor: "c1" });
    await loadMore();
    const second = harness.frames("sub")[1]!;
    await deliverPage(harness, second.id, 1n, { items: ["c"], nextCursor: null });

    await act(async () => {
      root.render(<AckerDBProvider config={harness.config()}><span /></AckerDBProvider>);
    });
    expect(harness.frames("unsub").map((frame) => frame.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    await act(async () => {
      root.unmount();
    });
  });

  test("application errors surface as data and clear the window", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, { list: 1n }, 2));
    await ready(harness);
    const first = harness.frames("sub")[0]!;
    await deliverPage(harness, first.id, 1n, { items: ["a", "b"], nextCursor: null });
    expect(container.textContent).toBe("fresh:a,b+end");
    await receive(harness, {
      v: PROTOCOL_VERSION,
      t: "transition",
      id: first.id,
      transition: {
        kind: "application-error",
        from: cursor(1n, `api.logs.list:${first.id}`),
        to: cursor(2n, `api.logs.list:${first.id}`),
        error: { kind: "application", code: "logs.gone", body: { list: 1n }, status: 410 },
      },
    });
    expect(container.textContent).toBe("application-error:logs.gone");

    await act(async () => {
      root.unmount();
    });
  });

  test("a paginated query must return a page object", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, { list: 1n }, 2));
    await ready(harness);
    const first = harness.frames("sub")[0]!;
    await deliverPage(harness, first.id, 1n, ["a", "b"] as never);
    expect(container.textContent).toBe("rejected:validation");

    await act(async () => {
      root.unmount();
    });
  });

  test("losing the connection marks the whole window stale", async () => {
    const harness = createHarness(APP);
    const container = mountPoint();
    const root = createRoot(container);

    await render(root, app(harness, { list: 1n }, 2));
    await ready(harness);
    const first = harness.frames("sub")[0]!;
    await deliverPage(harness, first.id, 1n, { items: ["a", "b"], nextCursor: "c1" });
    await loadMore();
    const second = harness.frames("sub")[1]!;
    await deliverPage(harness, second.id, 1n, { items: ["c"], nextCursor: null });
    expect(container.textContent).toBe("fresh:a,b,c+end");

    await act(async () => {
      harness.live().close();
    });
    // Exhaustion is data-derived, so it survives staleness.
    expect(container.textContent).toBe("stale:a,b,c+end");

    await act(async () => {
      root.unmount();
    });
  });
});
