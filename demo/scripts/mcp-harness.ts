import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DbzzClient, DbzzClientError } from "@dbzz/client";
import { loadConfig, startApp, type AppConfig, type RunningApp } from "@dbzz/cli";
import { api } from "@demo/dbzz-codegen/api";

const SERVER_DIR = fileURLToPath(new URL("../app/server", import.meta.url));
export const STAFF_TOKEN = process.env.DBZZ_DEMO_STAFF_TOKEN ?? "savoria-demo-staff";
export const MCP_PATH = "/mcp";
export const MCP_PROTOCOL_VERSION = "2025-11-25";

export type Scope = "read" | "operate";

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Boots the real demo backend on an ephemeral port with a throwaway db. */
export class McpHarness {
  readonly directory = mkdtempSync(join(tmpdir(), "dbzz-demo-mcp-"));
  readonly config: AppConfig;
  private app: RunningApp | undefined;
  private readonly clients = new Set<DbzzClient>();

  private constructor(env: Record<string, string>) {
    this.config = {
      ...loadConfig(SERVER_DIR, {
        ...process.env,
        DBZZ_DURABILITY: "balanced",
        DBZZ_TELEMETRY: "disabled",
        ...env,
      }),
      dbDir: join(this.directory, ".zdb"),
      port: 0,
    };
  }

  static async start(env: Record<string, string> = {}): Promise<McpHarness> {
    const harness = new McpHarness(env);
    harness.app = await startApp(harness.config);
    return harness;
  }

  get url(): string {
    if (this.app === undefined) throw new Error("backend is not running");
    return `http://127.0.0.1:${this.app.server.port}`;
  }

  client(token?: string): DbzzClient {
    const client = new DbzzClient({
      url: this.url,
      credential:
        token === undefined ? { kind: "anonymous" } : { kind: "bearer", token },
    });
    this.clients.add(client);
    return client;
  }

  async staff(): Promise<DbzzClient> {
    const staff = this.client(STAFF_TOKEN);
    await staff.mutation(api.setup.initialize, {});
    return staff;
  }

  async guest(email: string, name = "MCP Guest"): Promise<DbzzClient> {
    const login = await this.client().procedure(api.auth.login, { name, email });
    const client = this.client(login.token);
    await client.mutation(api.users.ensureCurrent, {});
    await client.query(api.users.current, {});
    return client;
  }

  /** Raw MCP JSON-RPC over HTTP — the exact surface external hosts touch. */
  rpc(method: string, params: unknown, token?: string, id = 1): Promise<Response> {
    return fetch(`${this.url}${MCP_PATH}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
  }

  /** `tools/call` sugar: returns the parsed body after asserting HTTP 200. */
  async call(
    tool: string,
    args: Record<string, unknown>,
    token?: string,
  ): Promise<JsonRpcResponse> {
    const response = await this.rpc("tools/call", { name: tool, arguments: args }, token);
    expect(response.status).toBe(200);
    return (await response.json()) as JsonRpcResponse;
  }

  async dispose(): Promise<void> {
    for (const client of this.clients) client.close();
    this.clients.clear();
    try {
      await this.app?.drain();
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}

export async function withBackend(
  work: (backend: McpHarness) => Promise<void>,
  env?: Record<string, string>,
): Promise<void> {
  const backend = await McpHarness.start(env);
  try {
    await work(backend);
  } finally {
    await backend.dispose();
  }
}

export async function expectCode(
  work: Promise<unknown>,
  code: DbzzClientError["code"],
): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(DbzzClientError);
    expect((error as DbzzClientError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

export function identityOf(client: DbzzClient): bigint {
  const auth = client.currentAuthentication;
  if (auth?.principal !== "user") throw new Error("expected a durable user identity");
  return auth.identity;
}

export function issueToken(staff: DbzzClient, name: string, scopes: Scope[]) {
  return staff.mutation(api.admin.tokens.create, { name, scopes });
}

export async function listedToolNames(response: Response): Promise<readonly string[]> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as JsonRpcResponse;
  const tools = (body.result?.tools ?? []) as readonly { readonly name: string }[];
  return tools.map((tool) => tool.name).sort();
}

/** The structured payload of a successful tools/call, typed by the caller. */
export function structuredOf<T>(body: JsonRpcResponse): T {
  expect(body.error).toBeUndefined();
  expect(body.result?.isError ?? false).toBe(false);
  return body.result?.structuredContent as T;
}
