import { totalSignal } from "./delivery.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogMetadata = Readonly<Record<string, unknown>>;

export interface LoggerStrategy {
  write(level: LogLevel, message: string, metadata?: LogMetadata): void;
}

export const consoleLoggerStrategy: LoggerStrategy = Object.freeze({
  write(level: LogLevel, message: string, metadata?: LogMetadata): void {
    if (metadata === undefined) {
      console.log(`[${level}] ${message}`);
      return;
    }
    console.log(`[${level}] ${message}`, metadata);
  },
});

export class Logger {
  readonly debug: (message: string, metadata?: LogMetadata) => void;
  readonly info: (message: string, metadata?: LogMetadata) => void;
  readonly warn: (message: string, metadata?: LogMetadata) => void;
  readonly error: (message: string, metadata?: LogMetadata) => void;

  constructor(strategy: LoggerStrategy = consoleLoggerStrategy) {
    this.debug = totalSignal((message, metadata) => strategy.write("debug", message, metadata));
    this.info = totalSignal((message, metadata) => strategy.write("info", message, metadata));
    this.warn = totalSignal((message, metadata) => strategy.write("warn", message, metadata));
    this.error = totalSignal((message, metadata) => strategy.write("error", message, metadata));
  }
}
