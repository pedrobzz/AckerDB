import { describe, expect, spyOn, test } from "bun:test";
import {
  Analytics,
  Logger,
  type AnalyticsProperties,
  type LogLevel,
  type LogMetadata,
} from "@ackerdb/server";

describe("application signals", () => {
  test("routes every log call through the configured strategy", () => {
    const writes: Array<{
      level: LogLevel;
      message: string;
      metadata?: LogMetadata;
    }> = [];
    const logger = new Logger({
      write: (level, message, metadata) => writes.push({ level, message, metadata }),
    });

    logger.debug("debug");
    logger.info("info", { request: 1 });
    logger.warn("warn");
    logger.error("error", { failure: true });

    expect(writes).toEqual([
      { level: "debug", message: "debug", metadata: undefined },
      { level: "info", message: "info", metadata: { request: 1 } },
      { level: "warn", message: "warn", metadata: undefined },
      { level: "error", message: "error", metadata: { failure: true } },
    ]);
  });

  test("routes analytics through the configured strategy", () => {
    const events: Array<{ event: string; properties?: AnalyticsProperties }> = [];
    const analytics = new Analytics({
      track: (event, properties) => events.push({ event, properties }),
    });

    analytics.track("opened");
    analytics.track("saved", { source: "editor" });

    expect(events).toEqual([
      { event: "opened", properties: undefined },
      { event: "saved", properties: { source: "editor" } },
    ]);
  });

  test("uses console.log by default", () => {
    const output = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      new Logger().info("ready", { port: 3211 });
      new Analytics().track("started", { mode: "local" });
      expect(output).toHaveBeenNthCalledWith(1, "[info] ready", { port: 3211 });
      expect(output).toHaveBeenNthCalledWith(2, "[analytics] started", { mode: "local" });
    } finally {
      output.mockRestore();
    }
  });
});
