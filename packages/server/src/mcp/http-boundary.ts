const MAX_CONFIGURED_AUTHORITIES = 32;
const MCP_ALLOWED_HEADERS = Object.freeze([
  "authorization",
  "content-type",
  "mcp-protocol-version",
] as const);

export interface McpHttpOptions {
  /** Exact HTTP authorities accepted in addition to safe loopback defaults. */
  readonly allowedHosts?: readonly string[];
  /** Exact browser origins allowed to call an MCP endpoint. */
  readonly allowedOrigins?: readonly string[];
  /** Assert that a non-loopback listener is private behind trusted HTTPS termination. */
  readonly transport?: "trusted-https-proxy";
}

export interface McpHttpBoundaryResult {
  readonly cors: Readonly<Record<string, string>>;
  readonly rejectionStatus?: 403 | 431;
}

const MCP_CORS = Object.freeze({
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": MCP_ALLOWED_HEADERS.join(", "),
  vary: "Origin",
});

function loopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "::1") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) =>
    /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function canonicalAuthority(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 320) return undefined;
  try {
    const url = new URL(`http://${value}`);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.host === ""
    ) {
      return undefined;
    }
    return url.host;
  } catch {
    return undefined;
  }
}

function canonicalOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin === "null" ||
      (url.protocol === "http:" && !loopbackHostname(url.hostname))
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function canonicalList(
  value: unknown,
  name: string,
  canonicalize: (entry: unknown) => string | undefined,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_CONFIGURED_AUTHORITIES) {
    throw new TypeError(`${name} must be an array of at most ${MAX_CONFIGURED_AUTHORITIES} entries`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const canonical = canonicalize(entry);
    if (canonical === undefined) throw new TypeError(`${name} contains an invalid entry`);
    if (seen.has(canonical)) throw new TypeError(`${name} contains a duplicate entry`);
    seen.add(canonical);
    result.push(canonical);
  }
  return Object.freeze(result);
}

function configuredOptions(value: McpHttpOptions | undefined): Readonly<{
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  transport?: "trusted-https-proxy";
}> {
  if (value === undefined) {
    return Object.freeze({ allowedHosts: Object.freeze([]), allowedOrigins: Object.freeze([]) });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("mcpHttp must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "allowedHosts" && key !== "allowedOrigins" && key !== "transport") {
      throw new TypeError(`unknown mcpHttp field "${key}"`);
    }
  }
  if (value.transport !== undefined && value.transport !== "trusted-https-proxy") {
    throw new TypeError('mcpHttp.transport must be "trusted-https-proxy"');
  }
  return Object.freeze({
    allowedHosts: canonicalList(value.allowedHosts, "mcpHttp.allowedHosts", canonicalAuthority),
    allowedOrigins: canonicalList(
      value.allowedOrigins,
      "mcpHttp.allowedOrigins",
      canonicalOrigin,
    ),
    ...(value.transport === undefined ? {} : { transport: value.transport }),
  });
}

function boundedHeaders(headers: Headers, maxBytes: number): boolean {
  let bytes = 2;
  for (const [name, value] of headers) {
    bytes += Buffer.byteLength(name) + 2 + Buffer.byteLength(value) + 2;
    if (bytes > maxBytes) return false;
  }
  return true;
}

function validPreflight(headers: Headers): boolean {
  if (headers.get("access-control-request-method") !== "POST") return false;
  const raw = headers.get("access-control-request-headers");
  if (raw === null) return false;
  const requested = raw.split(",").map((header) => header.trim().toLowerCase());
  if (
    requested.some((header) => header === "") ||
    new Set(requested).size !== requested.length ||
    !requested.includes("content-type")
  ) {
    return false;
  }
  return requested.every((header) => (MCP_ALLOWED_HEADERS as readonly string[]).includes(header));
}

/** One normalized Host/Origin boundary for every MCP route on the shared listener. */
export class McpHttpBoundary {
  private readonly local: boolean;
  private readonly configuredHosts: readonly string[];
  private readonly configuredOrigins: readonly string[];
  private readonly transport: "trusted-https-proxy" | undefined;
  private resolvedPort: number | undefined;
  private resolvedHosts: readonly string[] = Object.freeze([]);
  private resolvedOrigins: readonly string[] = Object.freeze([]);

  constructor(hostname: string, options?: McpHttpOptions) {
    const configured = configuredOptions(options);
    this.local = loopbackHostname(hostname);
    this.configuredHosts = configured.allowedHosts;
    this.configuredOrigins = configured.allowedOrigins;
    this.transport = configured.transport;
  }

  assertCanServe(exposesMcp: boolean): void {
    if (!exposesMcp || this.local) return;
    if (this.transport !== "trusted-https-proxy") {
      throw new TypeError(
        'non-loopback MCP listeners require mcpHttp.transport "trusted-https-proxy"',
      );
    }
    if (this.configuredHosts.length === 0) {
      throw new TypeError("non-loopback MCP listeners require mcpHttp.allowedHosts");
    }
  }

  inspect(request: Request, port: number, maxHeaderBytes: number): McpHttpBoundaryResult {
    if (!boundedHeaders(request.headers, maxHeaderBytes)) {
      return Object.freeze({ cors: MCP_CORS, rejectionStatus: 431 });
    }
    this.resolve(port);
    const authority = canonicalAuthority(request.headers.get("host"));
    if (authority === undefined || !this.resolvedHosts.includes(authority)) {
      return Object.freeze({ cors: MCP_CORS, rejectionStatus: 403 });
    }

    const rawOrigin = request.headers.get("origin");
    const origin = rawOrigin === null ? undefined : canonicalOrigin(rawOrigin);
    if (
      rawOrigin !== null &&
      (origin === undefined || !this.resolvedOrigins.includes(origin))
    ) {
      return Object.freeze({ cors: MCP_CORS, rejectionStatus: 403 });
    }
    const cors = origin === undefined
      ? MCP_CORS
      : Object.freeze({ ...MCP_CORS, "access-control-allow-origin": origin });
    if (request.method === "OPTIONS" && (origin === undefined || !validPreflight(request.headers))) {
      return Object.freeze({ cors, rejectionStatus: 403 });
    }
    return Object.freeze({ cors });
  }

  private resolve(port: number): void {
    if (this.resolvedPort === port) return;
    const localAuthorities = this.local
      ? [
          canonicalAuthority(`127.0.0.1:${port}`)!,
          canonicalAuthority(`localhost:${port}`)!,
          canonicalAuthority(`[::1]:${port}`)!,
        ]
      : [];
    this.resolvedHosts = Object.freeze([...new Set([
      ...localAuthorities,
      ...this.configuredHosts,
    ])]);
    this.resolvedOrigins = Object.freeze([...new Set([
      ...localAuthorities.map((host) => `http://${host}`),
      ...this.configuredOrigins,
    ])]);
    this.resolvedPort = port;
  }
}
