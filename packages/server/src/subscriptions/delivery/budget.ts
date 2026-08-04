export type OutboundLane = "application" | "control";

export interface OutboundBudgetSnapshot {
  readonly bytes: number;
  readonly applicationBytes: number;
  readonly controlBytes: number;
  /** Lifetime maximum simultaneous total ownership since construction. */
  readonly peakBytes: number;
  /** Independent lifetime maximum for the application lane. */
  readonly peakApplicationBytes: number;
  /** Independent lifetime maximum for the control lane. */
  readonly peakControlBytes: number;
  readonly maxBytes: number;
  readonly reservedControlBytes: number;
}

export interface OutboundReservation {
  readonly lane: OutboundLane;
  readonly remainingBytes: number;
  release(bytes?: number): void;
}

function byteCount(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
}

class BudgetReservation implements OutboundReservation {
  private remaining: number;

  constructor(
    private readonly owner: OutboundBudget,
    readonly lane: OutboundLane,
    bytes: number,
  ) {
    this.remaining = bytes;
  }

  get remainingBytes(): number {
    return this.remaining;
  }

  release(bytes = this.remaining): void {
    byteCount(bytes, "released bytes", true);
    if (bytes > this.remaining) throw new RangeError("cannot release more bytes than the reservation owns");
    if (bytes === 0) return;
    this.remaining -= bytes;
    this.owner.release(this.lane, bytes);
  }
}

/** Shared exact-byte budget. Application traffic cannot consume the control reserve. */
export class OutboundBudget {
  readonly maxBytes: number;
  readonly reservedControlBytes: number;

  private applicationBytes = 0;
  private controlBytes = 0;
  private peakBytes = 0;
  private peakApplicationBytes = 0;
  private peakControlBytes = 0;

  constructor(maxBytes: number, reservedControlBytes = 0) {
    byteCount(maxBytes, "maxBytes");
    byteCount(reservedControlBytes, "reservedControlBytes", true);
    if (reservedControlBytes >= maxBytes) {
      throw new RangeError("reservedControlBytes must be smaller than maxBytes");
    }
    this.maxBytes = maxBytes;
    this.reservedControlBytes = reservedControlBytes;
  }

  reserve(bytes: number, lane: OutboundLane): OutboundReservation | null {
    byteCount(bytes, "reserved bytes");
    if (bytes > this.availableBytes(lane)) return null;
    if (lane === "application") {
      this.applicationBytes += bytes;
      this.peakApplicationBytes = Math.max(this.peakApplicationBytes, this.applicationBytes);
    } else {
      this.controlBytes += bytes;
      this.peakControlBytes = Math.max(this.peakControlBytes, this.controlBytes);
    }
    this.peakBytes = Math.max(this.peakBytes, this.applicationBytes + this.controlBytes);
    return new BudgetReservation(this, lane, bytes);
  }

  availableBytes(lane: OutboundLane): number {
    const total = this.applicationBytes + this.controlBytes;
    const available = this.maxBytes - total;
    return lane === "control"
      ? available
      : Math.min(available, this.maxBytes - this.reservedControlBytes - this.applicationBytes);
  }

  snapshot(): OutboundBudgetSnapshot {
    return Object.freeze({
      bytes: this.applicationBytes + this.controlBytes,
      applicationBytes: this.applicationBytes,
      controlBytes: this.controlBytes,
      peakBytes: this.peakBytes,
      peakApplicationBytes: this.peakApplicationBytes,
      peakControlBytes: this.peakControlBytes,
      maxBytes: this.maxBytes,
      reservedControlBytes: this.reservedControlBytes,
    });
  }

  release(lane: OutboundLane, bytes: number): void {
    if (lane === "application") {
      if (bytes > this.applicationBytes) throw new Error("application budget underflow");
      this.applicationBytes -= bytes;
    } else {
      if (bytes > this.controlBytes) throw new Error("control budget underflow");
      this.controlBytes -= bytes;
    }
  }
}
