import type { ExternalHttpTrace } from "./external-trace.ts";

const HTTP_REQUEST_PROVENANCE: unique symbol = Symbol("dbzz.httpRequestProvenance");
const trustedProvenance = new WeakSet<object>();

interface HttpRequestProvenanceCarrier {
  readonly [HTTP_REQUEST_PROVENANCE]?: HttpRequestProvenance;
}

/** Package-internal transport ownership passed from Serve to Runtime. */
export interface HttpRequestProvenance {
  readonly bytes: number;
  readonly trace?: ExternalHttpTrace;
}

export function carryHttpRequestProvenance<T extends object>(
  value: T,
  bytes: number,
  trace: ExternalHttpTrace | undefined,
): T {
  const provenance = Object.freeze({
    bytes,
    ...(trace === undefined ? {} : { trace }),
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
