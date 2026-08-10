import type { AuthInvalidationPublisher } from "../auth/invalidation.ts";

const HTTP_REQUEST_PROVENANCE: unique symbol = Symbol("ackerdb.httpRequestProvenance");
const trustedProvenance = new WeakSet<object>();

interface HttpRequestProvenanceCarrier {
  readonly [HTTP_REQUEST_PROVENANCE]?: HttpRequestProvenance;
}

/** Package-internal transport ownership passed from Serve to Runtime. */
export interface HttpRequestProvenance {
  readonly bytes: number;
  /**
   * The caller's own auth-invalidation channel. It is the publisher and not the
   * bare scope because releasing the deferred delivery belongs to whoever owns
   * the response handoff, and for an HTTP request that is the listener rather
   * than anything inside the Runtime.
   */
  readonly invalidations?: AuthInvalidationPublisher;
}

export function carryHttpRequestProvenance<T extends object>(
  value: T,
  bytes: number,
  invalidations?: AuthInvalidationPublisher,
): T {
  const provenance = Object.freeze({
    bytes,
    ...(invalidations === undefined ? {} : { invalidations }),
  });
  trustedProvenance.add(provenance);
  Object.assign(value, { [HTTP_REQUEST_PROVENANCE]: provenance });
  return value;
}

export function claimHttpRequestProvenance(value: object): HttpRequestProvenance | undefined {
  const provenance = (value as HttpRequestProvenanceCarrier)[HTTP_REQUEST_PROVENANCE];
  if (provenance === undefined || !trustedProvenance.delete(provenance)) return undefined;
  return provenance;
}
