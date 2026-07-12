/**
 * The transport: one Bun.serve exposing
 *   - /ws            WebSocket — subscriptions, one-shot queries, mutations
 *   - POST /api/call query / mutation / procedure over HTTP
 *   - POST /api/sse  SSE procedures (AI-SDK-compatible data-only stream)
 *   - GET  /health
 *
 * Every WS frame and HTTP body is wire-encoded (see @dbzz/core). Subscription
 * updates embed the entry's pre-encoded result so a fan-out to N listeners
 * encodes once and concatenates N cheap frames.
 */
import type { Server, ServerWebSocket } from "bun";
import { decode, encode, type CallRequest, type ClientMessage } from "@dbzz/core";
import { ValidationError } from "./dbz.ts";
import type { Subscriber } from "./reactive.ts";
import type { Runtime } from "./runtime.ts";

class WsSubscriber implements Subscriber {
  constructor(private readonly ws: ServerWebSocket<WsData>) {}
  sendUpdate(subId: number, encodedValue: string): void {
    this.ws.send(`{"t":"update","id":${subId},"value":${encodedValue}}`);
  }
  sendEvent(subId: number, encodedRow: string): void {
    this.ws.send(`{"t":"event","id":${subId},"row":${encodedRow}}`);
  }
  sendError(subId: number, message: string): void {
    this.ws.send(encode({ t: "err", id: subId, message }));
  }
}

interface WsData {
  subscriber: WsSubscriber;
}

export interface ServeOptions {
  runtime: Runtime;
  port: number;
  hostname?: string;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

const SSE_HEADERS = {
  ...CORS,
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
};

function json(value: unknown, status = 200): Response {
  return new Response(encode(value), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function errorStatus(error: unknown): number {
  return error instanceof ValidationError ? 400 : 500;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serve(opts: ServeOptions): Server<WsData> {
  const { runtime } = opts;

  return Bun.serve<WsData, never>({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { subscriber: null as unknown as WsSubscriber } })) {
          return undefined as unknown as Response;
        }
        return new Response("websocket upgrade required", { status: 400 });
      }
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (url.pathname === "/health") return json({ ok: true });

      if (url.pathname === "/api/call" && req.method === "POST") {
        let call: CallRequest;
        try {
          call = decode(await req.text()) as CallRequest;
        } catch {
          return json({ error: "malformed request body" }, 400);
        }
        try {
          const kind = runtime.kindOf(call.ref);
          switch (kind) {
            case "query":
              return json({ value: await runtime.runQuery(call.ref, call.args) });
            case "mutation":
              return json({ value: await runtime.runMutation(call.ref, call.args, call.mid) });
            case "procedure":
              return json({ value: await runtime.runProcedure(call.ref, call.args) });
            case "sse":
              return json({ error: `"${call.ref}" is an SSE procedure — POST /api/sse` }, 400);
            default:
              return json({ error: `unknown function "${call.ref}"` }, 400);
          }
        } catch (error) {
          return json({ error: message(error) }, errorStatus(error));
        }
      }

      if (url.pathname === "/api/sse" && req.method === "POST") {
        let call: CallRequest;
        try {
          call = decode(await req.text()) as CallRequest;
        } catch {
          return json({ error: "malformed request body" }, 400);
        }
        try {
          const stream = runtime.runSse(call.ref, call.args, req.signal);
          return new Response(stream.pipeThrough(new TextEncoderStream()), {
            headers: SSE_HEADERS,
          });
        } catch (error) {
          return json({ error: message(error) }, errorStatus(error));
        }
      }

      return new Response("not found", { status: 404, headers: CORS });
    },
    websocket: {
      open(ws) {
        ws.data.subscriber = new WsSubscriber(ws);
      },
      async message(ws, raw) {
        let frame: ClientMessage;
        try {
          frame = decode(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ClientMessage;
        } catch {
          ws.send(encode({ t: "err", id: -1, message: "malformed frame" }));
          return;
        }
        const subscriber = ws.data.subscriber;
        try {
          switch (frame.t) {
            case "ping":
              ws.send(`{"t":"pong"}`);
              return;
            case "sub":
              await runtime.subscribe(frame.ref, frame.args, subscriber, frame.id);
              return;
            case "unsub":
              runtime.unsubscribe(subscriber, frame.id);
              return;
            case "q": {
              const value = await runtime.runQuery(frame.ref, frame.args);
              ws.send(encode({ t: "ok", id: frame.id, value }));
              return;
            }
            case "m": {
              const value = await runtime.runMutation(frame.ref, frame.args, frame.mid);
              ws.send(encode({ t: "ok", id: frame.id, value }));
              return;
            }
            default:
              ws.send(encode({ t: "err", id: -1, message: "unknown frame type" }));
          }
        } catch (error) {
          ws.send(encode({ t: "err", id: "id" in frame ? frame.id : -1, message: message(error) }));
        }
      },
      close(ws) {
        if (ws.data.subscriber !== null) runtime.disconnect(ws.data.subscriber);
      },
      idleTimeout: 120,
    },
  });
}
