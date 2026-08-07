/**
 * The re-arming monotonic deadline: a wake at the timer horizon is a re-arm,
 * never an expiry. Exercised with a tiny injected per-arm bound so horizon
 * wakes happen in milliseconds instead of 24.8 days.
 */
import { describe, expect, test } from "bun:test";
import { scheduleMonotonicDeadline } from "../../src/runtime/lifecycle/control.ts";

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!check() && performance.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  return check();
}

describe("scheduleMonotonicDeadline", () => {
  test("horizon wakes re-arm; expiry fires only past the target", async () => {
    const started = performance.now();
    let expiredAt = -1;
    const cancel = scheduleMonotonicDeadline(
      started + 100,
      () => {
        expiredAt = performance.now();
      },
      20,
    );
    // Several horizon wakes happen before the target; none may expire.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(expiredAt).toBe(-1);
    expect(await until(() => expiredAt >= 0, 500)).toBe(true);
    expect(expiredAt - started).toBeGreaterThanOrEqual(95);
    cancel();
  });

  test("an already-past target expires synchronously with no arm", () => {
    let expired = 0;
    scheduleMonotonicDeadline(performance.now() - 1, () => {
      expired++;
    });
    expect(expired).toBe(1);
  });

  test("cancel clears the armed timer across re-arms", async () => {
    let expired = 0;
    const cancel = scheduleMonotonicDeadline(
      performance.now() + 80,
      () => {
        expired++;
      },
      15,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(expired).toBe(0);
  });
});
