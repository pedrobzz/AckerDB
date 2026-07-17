const NO_SLOT = -1;

export interface TraceJournalChain {
  stagedHead: number;
  stagedTail: number;
  stagedRecords: number;
  stagedBytes: number;
}

export interface ReleasedTraceJournal {
  readonly records: number;
  readonly bytes: number;
}

/** Fixed reusable slots for sanitized spans awaiting one tail decision. */
export class TraceJournal<Span> {
  private freeHead: number;
  private readonly next: Int32Array;
  private readonly bytes: Float64Array;
  private readonly spans: Array<Span | undefined>;

  constructor(capacity: number) {
    this.next = new Int32Array(capacity);
    this.bytes = new Float64Array(capacity);
    this.spans = new Array(capacity);
    for (let index = 0; index < capacity; index++) {
      this.next[index] = index + 1 < capacity ? index + 1 : NO_SLOT;
    }
    this.freeHead = capacity === 0 ? NO_SLOT : 0;
  }

  append(chain: TraceJournalChain, span: Span, bytes: number): boolean {
    const slot = this.freeHead;
    if (slot === NO_SLOT) return false;
    this.freeHead = this.next[slot]!;
    this.next[slot] = NO_SLOT;
    this.spans[slot] = span;
    this.bytes[slot] = bytes;
    if (chain.stagedTail === NO_SLOT) chain.stagedHead = slot;
    else this.next[chain.stagedTail] = slot;
    chain.stagedTail = slot;
    chain.stagedRecords++;
    chain.stagedBytes += bytes;
    return true;
  }

  drain(chain: TraceJournalChain, visit?: (span: Span) => void): ReleasedTraceJournal {
    const released = { records: chain.stagedRecords, bytes: chain.stagedBytes };
    const head = chain.stagedHead;
    chain.stagedHead = NO_SLOT;
    chain.stagedTail = NO_SLOT;
    chain.stagedRecords = 0;
    chain.stagedBytes = 0;
    for (let slot = head; slot !== NO_SLOT;) {
      const next = this.next[slot]!;
      if (visit !== undefined) visit(this.spans[slot]!);
      this.spans[slot] = undefined;
      this.next[slot] = this.freeHead;
      this.freeHead = slot;
      slot = next;
    }
    return released;
  }
}
