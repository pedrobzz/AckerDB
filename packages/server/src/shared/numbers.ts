/** The largest delay `setTimeout` can hold: a 32-bit signed millisecond count. */
export const MAX_TIMER_DELAY_MS = 0x7fff_ffff;

export function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
