import { expect, test } from "bun:test";
import { formatMoney } from "./format";

test("formats exact dollars without decimals", () => {
  expect(formatMoney(1600)).toBe("$16");
});

test("preserves cent values with two decimals", () => {
  expect(formatMoney(1650)).toBe("$16.50");
  expect(formatMoney(1699)).toBe("$16.99");
});
