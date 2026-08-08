/**
 * The authenticated probe: one request to `admin.system.info` on the Studio
 * origin, whose answer is the whole connect verdict.
 *
 * **It is a request, not a subscription, because it has to answer before a
 * session exists.** Deciding whether a credential can open a session by
 * watching a session open is circular: a client that has never connected
 * reports "connecting" indefinitely, which is indistinguishable from a
 * stopped application — exactly the case an operator runs `acker studio` to
 * diagnose. A request/response either comes back or does not, and the proxy's
 * own `502` is a first-class part of the answer rather than a silence.
 *
 * The address is derived, never spelled: `admin.system.info` is a reference
 * like any other, and its route is that address segment for segment.
 */
import { adminApi, getRef, httpPathForAddress, type AdminSystemInfo } from "@ackerdb/core";

/** The proxy's answer when it cannot reach the application; see the launcher. */
const PROXY_UNREACHABLE_STATUS = 502;

export const ADMIN_SYSTEM_INFO_PATH = httpPathForAddress(getRef(adminApi.system.info));

export type StudioProbe =
  /** No answer yet. */
  | { readonly status: "pending" }
  /** Studio is serving and the application is not answering it. */
  | { readonly status: "unreachable"; readonly detail: string }
  /** The application answered and would not run the function. */
  | { readonly status: "refused"; readonly detail: string }
  /** The credential opened the Admin API; this is what the application calls itself. */
  | { readonly status: "open"; readonly application: AdminSystemInfo };

/** The shape every framework error answers with, over every transport. */
interface OutcomeBody {
  readonly message?: unknown;
  readonly code?: unknown;
}

function refusal(status: number, body: unknown): StudioProbe {
  const outcome = body as OutcomeBody | null;
  const message = typeof outcome?.message === "string" ? outcome.message : `HTTP ${status}`;
  return { status: "refused", detail: message };
}

/**
 * The one capability the probe needs: send a request to a path on this origin.
 * Naming it, rather than taking `typeof fetch`, is what lets the rule be
 * exercised against a stated contract instead of a global.
 */
export type StudioFetch = (
  path: string,
  init?: { readonly headers?: Readonly<Record<string, string>> },
) => Promise<Response>;

/** Ask the Admin API whether this credential opens it. */
export async function probeAdminApi(
  request: StudioFetch,
  credential: string | null,
): Promise<StudioProbe> {
  let response: Response;
  try {
    response = await request(ADMIN_SYSTEM_INFO_PATH, {
      headers: credential === null ? {} : { authorization: `Bearer ${credential}` },
    });
  } catch (error) {
    // Studio answered the page, so a failed request here is the hop to the
    // application, not the browser's connection to Studio.
    return {
      status: "unreachable",
      detail: error instanceof Error ? error.message : "the request did not complete",
    };
  }
  if (response.status === PROXY_UNREACHABLE_STATUS) {
    return { status: "unreachable", detail: (await response.text()).trim() };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "refused", detail: `the application answered HTTP ${response.status}` };
  }
  if (!response.ok) return refusal(response.status, body);
  return { status: "open", application: body as AdminSystemInfo };
}
