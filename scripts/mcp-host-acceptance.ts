import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { createPackedConsumer } from "./packed-consumer.ts";

const SERVER_NAME = "dbzz_acceptance";
const INSTRUCTION_MARKER = "dbzz-host-instructions-v1";
const READ_SCOPE = "acceptance.read";
const ADMIN_SCOPE = "acceptance.admin";
const PUBLIC_TOOLS = ["public_text"] as const;
const READ_TOOLS = [
  "authenticated_status",
  "public_text",
  "record_discovery",
  "revocation_checkpoint",
  "rich_content",
  "scope_checkpoint",
  "structured_status",
] as const;
const FULL_TOOLS = [...READ_TOOLS, "admin_only"].sort();

type Host = "codex" | "claude";

interface Token {
  readonly id: string;
  readonly token: string;
}

interface FixtureReady {
  readonly type: "ready";
  readonly url: string;
  readonly codex: Token;
  readonly claude: Token;
}

interface FixtureEvent {
  readonly type: string;
  readonly name?: string;
  readonly action?: string;
  readonly accepted?: boolean;
}

interface RpcObservation {
  readonly method: string;
  readonly tool?: string;
  readonly status: number;
  readonly response: unknown;
}

interface HostResult {
  readonly output: string;
  readonly stderr: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  consume: (line: string) => void | Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line !== "") await consume(line);
    }
  }
  buffered += decoder.decode();
  if (buffered !== "") await consume(buffered);
}

class FixtureController {
  readonly ready: Promise<FixtureReady>;
  readonly events: FixtureEvent[] = [];
  private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly output: Promise<void>;
  private readonly stderr: Promise<string>;
  private readonly waiters = new Set<() => void>();

  constructor(consumerDir: string) {
    this.child = Bun.spawn([process.execPath, "mcp-host-server.ts"], {
      cwd: consumerDir,
      env: {
        ...process.env,
        DBZZ_ACCEPTANCE_DB: join(consumerDir, "acceptance.db"),
        DBZZ_DURABILITY: "balanced",
        DBZZ_TELEMETRY: "disabled",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let resolveReady!: (value: FixtureReady) => void;
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<FixtureReady>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const readyTimeout = setTimeout(
      () => rejectReady(new Error("timed out waiting for MCP fixture startup")),
      30_000,
    );
    this.ready = ready.finally(() => clearTimeout(readyTimeout));
    void this.child.exited.then((exitCode) => {
      rejectReady(new Error(`MCP fixture exited ${exitCode} before startup completed`));
    });
    this.output = readLines(this.child.stdout, (line) => {
      const event = JSON.parse(line) as FixtureEvent | FixtureReady;
      if (event.type === "ready") {
        resolveReady(event as FixtureReady);
        return;
      }
      this.events.push(event);
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    }).catch((error) => {
      rejectReady(error);
      throw error;
    });
    this.stderr = new Response(this.child.stderr).text();
  }

  countTools(name: string): number {
    return this.events.filter((event) => event.type === "tool" && event.name === name).length;
  }

  countAcceptedDiscoveries(): number {
    return this.events.filter((event) =>
      event.type === "discovery" && event.accepted === true
    ).length;
  }

  async scopes(id: string, scopes: readonly string[]): Promise<void> {
    await this.control({ action: "scopes", id, scopes });
  }

  async revoke(id: string): Promise<void> {
    await this.control({ action: "revoke", id });
  }

  async sync(): Promise<void> {
    await this.control({ action: "sync" });
  }

  private async control(message: Readonly<Record<string, unknown>>): Promise<void> {
    const start = this.events.length;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    await this.child.stdin.flush();
    await this.waitFor(
      (event) => event.type === "control" && event.action === message.action,
      start,
    );
  }

  private async waitFor(
    predicate: (event: FixtureEvent) => boolean,
    start: number,
  ): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (true) {
      if (this.events.slice(start).some(predicate)) return;
      if (Date.now() >= deadline) throw new Error("timed out waiting for MCP fixture control");
      await new Promise<void>((resolve) => {
        let wake!: () => void;
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          resolve();
        }, 250);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) {
      this.child.stdin.write(`${JSON.stringify({ action: "stop" })}\n`);
      await this.child.stdin.flush();
      this.child.stdin.end();
    }
    const [exitCode, stderr] = await Promise.all([
      this.child.exited,
      this.stderr,
      this.output,
    ]).then(([code, text]) => [code, text] as const);
    if (exitCode !== 0) throw new Error(`MCP fixture exited ${exitCode}: ${stderr}`);
  }
}

function responseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return headers;
}

class RpcRecorder {
  readonly observations: RpcObservation[] = [];
  readonly url: string;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(
    target: string,
    transition?: (tool: string) => Promise<void>,
  ) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const bytes = request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
        let method = request.method;
        let tool: string | undefined;
        if (bytes !== undefined && bytes.byteLength > 0) {
          const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
          if (typeof body.method === "string") method = body.method;
          if (body.method === "tools/call") {
            const name = valueAt(body, "params", "name");
            if (typeof name === "string") tool = name;
          }
        }
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("content-length");
        const response = await fetch(target, {
          method: request.method,
          headers,
          ...(bytes === undefined ? {} : { body: bytes }),
        });
        const responseBytes = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") ?? "";
        const parsed = contentType.includes("json") && responseBytes.byteLength > 0
          ? JSON.parse(new TextDecoder().decode(responseBytes))
          : null;
        this.observations.push({
          method,
          ...(tool === undefined ? {} : { tool }),
          status: response.status,
          response: parsed,
        });
        if (tool !== undefined && response.ok && transition !== undefined) {
          await transition(tool);
        }
        return new Response(responseBytes, {
          status: response.status,
          headers: responseHeaders(response.headers),
        });
      },
    });
    const path = new URL(target).pathname;
    this.url = `http://127.0.0.1:${this.server.port}${path}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}

async function capture(
  stream: ReadableStream<Uint8Array>,
  maximumBytes = 2 * 1024 * 1024,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) throw new Error("host output exceeded 2 MiB");
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function hostArgs(
  host: Host,
  binary: string,
  cwd: string,
  url: string,
  token: string | undefined,
  tools: readonly string[],
  prompt: string,
): string[] {
  if (host === "codex") {
    return [
      binary,
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "--color",
      "never",
      "--cd",
      cwd,
      "--config",
      `mcp_servers.${SERVER_NAME}.url=${JSON.stringify(url)}`,
      "--config",
      `mcp_servers.${SERVER_NAME}.default_tools_approval_mode=\"approve\"`,
      ...(token === undefined
        ? []
        : [
            "--config",
            `mcp_servers.${SERVER_NAME}.bearer_token_env_var=\"DBZZ_MCP_TOKEN\"`,
          ]),
      prompt,
    ];
  }
  const config = JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: {
        type: "http",
        url,
        ...(token === undefined
          ? {}
          : { headers: { Authorization: "Bearer ${DBZZ_MCP_TOKEN}" } }),
      },
    },
  });
  return [
    binary,
    prompt,
    "--print",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--tools",
    "",
    "--allowedTools",
    tools.map((tool) => `mcp__${SERVER_NAME}__${tool}`).join(","),
    "--strict-mcp-config",
    "--mcp-config",
    config,
  ];
}

async function runHost(
  host: Host,
  binary: string,
  cwd: string,
  url: string,
  token: string | undefined,
  tools: readonly string[],
  prompt: string,
): Promise<HostResult> {
  const env = { ...process.env };
  if (token === undefined) delete env.DBZZ_MCP_TOKEN;
  else env.DBZZ_MCP_TOKEN = token;
  const child = Bun.spawn(hostArgs(host, binary, cwd, url, token, tools, prompt), {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 5 * 60 * 1_000);
  try {
    const [exitCode, output, stderr] = await Promise.all([
      child.exited,
      capture(child.stdout),
      capture(child.stderr),
    ]);
    if (exitCode !== 0) {
      throw new Error(`${host} exited ${exitCode}\n${output}\n${stderr}`);
    }
    return { output, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function toolLists(observations: readonly RpcObservation[]): string[][] {
  return observations
    .filter((observation) => observation.method === "tools/list" && observation.status === 200)
    .map((observation) => {
      const tools = valueAt(observation.response, "result", "tools");
      assert(Array.isArray(tools), "tools/list did not return a tool array");
      return tools.map((tool) => {
        const name = valueAt(tool, "name");
        assert(typeof name === "string", "tools/list returned a tool without a name");
        return name;
      }).sort();
    });
}

function assertToolList(
  host: Host,
  observations: readonly RpcObservation[],
  expected: readonly string[],
): void {
  const target = [...expected].sort();
  assert(
    toolLists(observations).some((list) => Bun.deepEquals(list, target)),
    `${host} did not discover the expected tools: ${target.join(", ")}`,
  );
}

function calls(
  observations: readonly RpcObservation[],
  tool: string,
): RpcObservation[] {
  return observations.filter((observation) =>
    observation.method === "tools/call" && observation.tool === tool
  );
}

function assertInitialize(host: Host, observations: readonly RpcObservation[]): void {
  const initialization = observations.find((observation) =>
    observation.method === "initialize" && observation.status === 200
  );
  assert(initialization !== undefined, `${host} did not initialize the MCP endpoint`);
  const instructions = valueAt(initialization.response, "result", "instructions");
  assert(
    typeof instructions === "string" && instructions.includes(INSTRUCTION_MARKER),
    `${host} did not receive the server instructions`,
  );
}

function assertBasic(host: Host, recorder: RpcRecorder): void {
  assertInitialize(host, recorder.observations);
  assertToolList(host, recorder.observations, READ_TOOLS);
  for (const tool of [
    "record_discovery",
    "public_text",
    "authenticated_status",
    "structured_status",
    "rich_content",
  ]) {
    assert(
      calls(recorder.observations, tool).some((call) => call.status === 200),
      `${host} did not successfully call ${tool}`,
    );
  }
  const structured = calls(recorder.observations, "structured_status").find((call) =>
    call.status === 200
  );
  assert(
    valueAt(structured?.response, "result", "structuredContent", "kind") === "structured",
    `${host} did not receive structuredContent`,
  );
  const content = valueAt(
    calls(recorder.observations, "rich_content").find((call) => call.status === 200)?.response,
    "result",
    "content",
  );
  assert(Array.isArray(content), `${host} did not receive rich content`);
  const contentTypes = content.map((block) => valueAt(block, "type"));
  assert(
    ["text", "resource", "resource_link"].every((type) => contentTypes.includes(type)),
    `${host} did not receive every rich-content fixture`,
  );
}

function assertStateTransitions(host: Host, recorder: RpcRecorder): void {
  assertInitialize(host, recorder.observations);
  assertToolList(host, recorder.observations, FULL_TOOLS);
  const admin = calls(recorder.observations, "admin_only");
  assert(
    admin.some((call) => call.status === 200),
    `${host} did not call admin_only before reduction`,
  );
  assert(admin.some((call) => call.status === 403), `${host} did not surface insufficient scope`);
  assert(
    calls(recorder.observations, "scope_checkpoint").some((call) => call.status === 200),
    `${host} did not reach the scope checkpoint`,
  );
  assert(
    calls(recorder.observations, "revocation_checkpoint").some((call) => call.status === 200),
    `${host} did not reach the revocation checkpoint`,
  );
  const authenticated = calls(recorder.observations, "authenticated_status");
  assert(
    authenticated.some((call) => call.status === 200),
    `${host} did not call authenticated_status before revocation`,
  );
  assert(
    authenticated.some((call) => call.status === 401),
    `${host} did not surface live token revocation`,
  );
}

function jsonLines(output: string): unknown[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function assertStructuredFailures(host: Host, output: string): void {
  const events = jsonLines(output);
  if (host === "codex") {
    const failed = events
      .filter((event) =>
        valueAt(event, "type") === "item.completed" &&
        valueAt(event, "item", "type") === "mcp_tool_call" &&
        valueAt(event, "item", "status") === "failed"
      )
      .map((event) => valueAt(event, "item", "tool"));
    assert(
      failed.includes("admin_only"),
      "codex did not classify the insufficient-scope MCP call as failed",
    );
    assert(
      failed.includes("authenticated_status"),
      "codex did not classify the revoked-token MCP call as failed",
    );
    return;
  }

  const toolNames = new Map<string, string>();
  const errorIds = new Set<string>();
  for (const event of events) {
    const content = valueAt(event, "message", "content");
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (valueAt(block, "type") === "tool_use") {
        const id = valueAt(block, "id");
        const name = valueAt(block, "name");
        if (typeof id === "string" && typeof name === "string") toolNames.set(id, name);
      } else if (
        valueAt(block, "type") === "tool_result" && valueAt(block, "is_error") === true
      ) {
        const id = valueAt(block, "tool_use_id");
        if (typeof id === "string") errorIds.add(id);
      }
    }
  }
  const failed = [...errorIds].map((id) => toolNames.get(id));
  assert(
    failed.includes(`mcp__${SERVER_NAME}__admin_only`),
    "claude did not classify the insufficient-scope MCP call as an error",
  );
  assert(
    failed.includes(`mcp__${SERVER_NAME}__authenticated_status`),
    "claude did not classify the revoked-token MCP call as an error",
  );
}

async function acceptHost(
  host: Host,
  binary: string,
  hostVersion: string,
  fixture: FixtureController,
  endpoint: string,
  token: Token,
  consumerDir: string,
): Promise<void> {
  const publicRecorder = new RpcRecorder(endpoint);
  try {
    const publicResult = await runHost(
      host,
      binary,
      consumerDir,
      publicRecorder.url,
      undefined,
      PUBLIC_TOOLS,
      `Use only the ${SERVER_NAME} MCP server. Call public_text exactly once, then answer ` +
        `with the returned public marker. Do not use shell, files, web, or any non-MCP tool.`,
    );
    assertInitialize(host, publicRecorder.observations);
    assertToolList(host, publicRecorder.observations, PUBLIC_TOOLS);
    assert(
      calls(publicRecorder.observations, "public_text").some((call) => call.status === 200),
      `${host} did not call the anonymous public tool\n${publicResult.output}\n${publicResult.stderr}`,
    );
  } finally {
    publicRecorder.stop();
  }

  const acceptedBefore = fixture.countAcceptedDiscoveries();
  const basicRecorder = new RpcRecorder(endpoint);
  try {
    await runHost(
      host,
      binary,
      consumerDir,
      basicRecorder.url,
      token.token,
      READ_TOOLS,
      `Run the deterministic ${SERVER_NAME} MCP acceptance sequence. First call record_discovery ` +
        `with the marker stated only in the server instructions and the exact lower-snake-case ` +
        `names of every currently available tool. Then call public_text, authenticated_status, ` +
        `structured_status with value "${host}:structured", and rich_content, in that order. ` +
        `Do not use shell, files, web, or any non-MCP tool.`,
    );
    await fixture.sync();
    assertBasic(host, basicRecorder);
    assert(
      fixture.countAcceptedDiscoveries() === acceptedBefore + 1,
      `${host} did not apply instructions to exact least-privilege discovery`,
    );
  } finally {
    basicRecorder.stop();
  }

  await fixture.scopes(token.id, [READ_SCOPE, ADMIN_SCOPE]);
  const adminBefore = fixture.countTools("admin_only");
  const authenticatedBefore = fixture.countTools("authenticated_status");
  let reduced = false;
  let revoked = false;
  const stateRecorder = new RpcRecorder(endpoint, async (tool) => {
    if (tool === "scope_checkpoint" && !reduced) {
      reduced = true;
      await fixture.scopes(token.id, [READ_SCOPE]);
    } else if (tool === "revocation_checkpoint" && !revoked) {
      revoked = true;
      await fixture.revoke(token.id);
    }
  });
  let stateResult: HostResult;
  try {
    stateResult = await runHost(
      host,
      binary,
      consumerDir,
      stateRecorder.url,
      token.token,
      FULL_TOOLS,
      `Run this exact ${SERVER_NAME} MCP authorization sequence and continue after expected tool ` +
        `errors: call admin_only; call scope_checkpoint; call admin_only again even though the ` +
        `controller has reduced the token; call authenticated_status; call revocation_checkpoint; ` +
        `then call authenticated_status again even though the controller has revoked the token. ` +
        `Do not substitute tools and do not use shell, files, web, or any non-MCP tool.`,
    );
    await fixture.sync();
    assertStateTransitions(host, stateRecorder);
    assert(reduced && revoked, `${host} did not cross both authority checkpoints`);
    assert(
      fixture.countTools("admin_only") === adminBefore + 1,
      `${host} executed admin_only after its scope was removed`,
    );
    assert(
      fixture.countTools("authenticated_status") === authenticatedBefore + 1,
      `${host} executed authenticated_status after revocation`,
    );
  } finally {
    stateRecorder.stop();
  }
  assertStructuredFailures(host, stateResult!.output);

  console.log(
    `✓ ${host} ${hostVersion}: public, least-privilege, structured/rich, scope, revoke`,
  );
}

async function version(binary: string): Promise<string> {
  const child = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${binary} --version failed: ${stderr}`);
  return stdout.trim();
}

async function main(): Promise<void> {
  const codex = Bun.which("codex");
  const claude = Bun.which("claude");
  assert(codex !== null, "codex is not installed on PATH");
  assert(claude !== null, "claude is not installed on PATH");
  const [codexVersion, claudeVersion] = await Promise.all([version(codex), version(claude)]);
  const packed = await createPackedConsumer("dbzz-mcp-host-acceptance");
  try {
    copyFileSync(
      join(packed.root, "scripts/fixtures/mcp-host-server.ts"),
      join(packed.consumerDir, "mcp-host-server.ts"),
    );
    const fixture = new FixtureController(packed.consumerDir);
    try {
      const ready = await fixture.ready;
      await acceptHost(
        "codex",
        codex,
        codexVersion,
        fixture,
        ready.url,
        ready.codex,
        packed.consumerDir,
      );
      await acceptHost(
        "claude",
        claude,
        claudeVersion,
        fixture,
        ready.url,
        ready.claude,
        packed.consumerDir,
      );
      console.log(
        `Real MCP hosts passed against packed @dbzz/* ${packed.version}; ` +
          `credentials remained environment-backed and ephemeral.`,
      );
    } finally {
      await fixture.close();
    }
  } finally {
    packed.cleanup();
  }
}

await main();
