/**
 * Throwaway T4 parser comparison, not release evidence.
 *
 * Run from the repository root:
 *   bun bench/client-sse-parser.prototype.ts
 */
import { heapStats } from "bun:jsc";
import {
  decodeSseEvent,
  encodeSseChunk,
  encodeSseControl,
  PROTOCOL_VERSION,
  type SseMessage,
} from "../packages/core/src/index.ts";
import { SseEventDecoder } from "../packages/client/src/sse/event-decoder.ts";

const EVENTS = 50_000;
const CHUNK_BYTES = 257;
const MAX_BUFFER_BYTES = 64 * 1024;
const TRIALS = 7;
const utf8 = new TextEncoder();

interface Decoder {
  push(chunk: Uint8Array): SseMessage[];
  finish(): SseMessage[];
}

interface Measurement {
  readonly parser: "legacy" | "eventsource-parser";
  readonly elapsedMs: number;
  readonly peakHeapGrowthBytes: number;
  readonly retainedHeapGrowthBytes: number;
  readonly peakRssGrowthBytes: number;
  readonly frames: number;
}

class LegacyDecoder implements Decoder {
  private readonly decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  private buffer = "";
  private pendingBytes = 0;
  private scanFrom = 0;

  constructor(private readonly maxBufferBytes: number) {}

  push(chunk: Uint8Array): SseMessage[] {
    this.pendingBytes += chunk.byteLength;
    if (this.pendingBytes > this.maxBufferBytes) {
      throw new RangeError("SSE input exceeds the client buffer limit");
    }
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  finish(): SseMessage[] {
    this.buffer += this.decoder.decode();
    const frames = this.drain();
    if (this.buffer.length !== 0) throw new Error("SSE stream ended mid-event");
    return frames;
  }

  private drain(): SseMessage[] {
    const frames: SseMessage[] = [];
    for (;;) {
      const lfBoundary = this.buffer.indexOf("\n\n", this.scanFrom);
      const crlfBoundary = this.buffer.indexOf("\r\n\r\n", this.scanFrom);
      const useCrlf = crlfBoundary !== -1 &&
        (lfBoundary === -1 || crlfBoundary < lfBoundary);
      const boundary = useCrlf ? crlfBoundary : lfBoundary;
      if (boundary === -1) {
        this.scanFrom = Math.max(0, this.buffer.length - 3);
        return frames;
      }
      const consumedEnd = boundary + (useCrlf ? 4 : 2);
      const block = this.buffer.slice(0, boundary).replaceAll("\r\n", "\n");
      this.pendingBytes -= utf8.encode(this.buffer.slice(0, consumedEnd)).byteLength;
      this.buffer = this.buffer.slice(consumedEnd);
      this.scanFrom = 0;
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1
          ? ""
          : line.slice(separator + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length !== 0) frames.push(decodeSseEvent(data.join("\n"), event));
    }
  }
}

function input(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let sequence = 1; sequence <= EVENTS; sequence++) {
    frames.push(encodeSseChunk(sequence, "proof", {
      sequence,
      value: "x".repeat(64),
    }));
  }
  frames.push(encodeSseControl({
    v: PROTOCOL_VERSION,
    t: "sse_done",
    seq: EVENTS + 1,
    proof: "proof",
  }));
  const wire = new Uint8Array(frames.reduce((bytes, frame) => bytes + frame.byteLength, 0));
  let offset = 0;
  for (const frame of frames) {
    wire.set(frame, offset);
    offset += frame.byteLength;
  }
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < wire.byteLength; start += CHUNK_BYTES) {
    chunks.push(wire.subarray(start, start + CHUNK_BYTES));
  }
  return chunks;
}

function parse(
  parser: "legacy" | "eventsource-parser",
  chunks: readonly Uint8Array[],
  sample?: () => void,
): number {
  const decoder: Decoder = parser === "legacy"
    ? new LegacyDecoder(MAX_BUFFER_BYTES)
    : new SseEventDecoder(MAX_BUFFER_BYTES);
  let frames = 0;
  for (let index = 0; index < chunks.length; index++) {
    frames += decoder.push(chunks[index]!).length;
    if ((index & 255) === 0) sample?.();
  }
  return frames + decoder.finish().length;
}

function measure(parser: "legacy" | "eventsource-parser"): Measurement {
  const chunks = input();
  parse(parser, chunks);
  Bun.gc(true);
  const baselineHeap = heapStats().heapSize;
  const baselineRss = process.memoryUsage().rss;
  let peakHeap = baselineHeap;
  let peakRss = baselineRss;
  const sample = () => {
    peakHeap = Math.max(peakHeap, heapStats().heapSize);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  const startedAt = performance.now();
  const frames = parse(parser, chunks, sample);
  const elapsedMs = performance.now() - startedAt;
  sample();
  Bun.gc(true);
  const retainedHeap = heapStats().heapSize;
  if (frames !== EVENTS + 1) throw new Error(`decoded ${frames} frames`);
  return {
    parser,
    elapsedMs,
    peakHeapGrowthBytes: peakHeap - baselineHeap,
    retainedHeapGrowthBytes: retainedHeap - baselineHeap,
    peakRssGrowthBytes: peakRss - baselineRss,
    frames,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const selected = Bun.argv[2];
if (selected === "legacy" || selected === "eventsource-parser") {
  console.log(JSON.stringify(measure(selected)));
} else {
  const measurements: Measurement[] = [];
  for (let trial = 0; trial < TRIALS; trial++) {
    for (const parser of trial % 2 === 0
      ? ["legacy", "eventsource-parser"] as const
      : ["eventsource-parser", "legacy"] as const) {
      const child = Bun.spawnSync([process.execPath, import.meta.path, parser], {
        stdout: "pipe",
        stderr: "inherit",
      });
      if (child.exitCode !== 0) throw new Error(`${parser} trial failed`);
      measurements.push(JSON.parse(child.stdout.toString()) as Measurement);
    }
  }
  for (const parser of ["legacy", "eventsource-parser"] as const) {
    const trials = measurements.filter((measurement) => measurement.parser === parser);
    console.log(JSON.stringify({
      parser,
      events: EVENTS + 1,
      chunkBytes: CHUNK_BYTES,
      medianElapsedMs: median(trials.map((trial) => trial.elapsedMs)),
      medianPeakHeapGrowthBytes: median(
        trials.map((trial) => trial.peakHeapGrowthBytes),
      ),
      medianRetainedHeapGrowthBytes: median(
        trials.map((trial) => trial.retainedHeapGrowthBytes),
      ),
      medianPeakRssGrowthBytes: median(
        trials.map((trial) => trial.peakRssGrowthBytes),
      ),
    }));
  }
}
