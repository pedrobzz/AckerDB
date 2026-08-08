import { randomUUID } from "node:crypto";
import type {
  AnalyticsEventRecord,
  AnalyticsTracker,
  ApplicationLogger,
  ApplicationLogCallContext,
  ApplicationLogLevel,
} from "./types.ts";
import type { TelemetryJournal } from "./journal.ts";
import {
  prepareTelemetryMessage,
  prepareTelemetryMetadata,
  type TelemetryMetadata,
} from "./value.ts";
import type { Principal } from "../../auth/credentials.ts";
import { stageAnalyticsEvent } from "../../runtime/invocation-state.ts";

export class ApplicationSignals {
  readonly log: ApplicationLogger;
  readonly processGeneration = randomUUID();
  private sequence = 0n;
  private readonly functionLoggers = new Map<string, ApplicationLogger>();

  constructor(
    private readonly journal: TelemetryJournal,
    private readonly now: () => number,
    private readonly context: () => ApplicationLogCallContext,
  ) {
    this.log = this.createLogger();
  }

  forFunction(functionAddress: string, functionKind: string): ApplicationLogger {
    const key = `${functionKind}\0${functionAddress}`;
    let logger = this.functionLoggers.get(key);
    if (logger !== undefined) return logger;
    logger = this.createLogger({ functionAddress, functionKind });
    this.functionLoggers.set(key, logger);
    return logger;
  }

  analyticsFor(
    principal: Principal,
    override?: Pick<ApplicationLogCallContext, "functionAddress" | "functionKind">,
  ): AnalyticsTracker {
    const identity = principal.kind === "user" ? principal.identity : undefined;
    return Object.freeze({
      track: (event: string, properties?: TelemetryMetadata): void => {
        try {
          const sequence = ++this.sequence;
          const timestamp = this.now();
          const context = this.context();
          const preparedEvent = prepareTelemetryMessage(event);
          const preparedProperties = prepareTelemetryMetadata(properties);
          stageAnalyticsEvent(Object.freeze({
            kind: "analytics",
            processGeneration: this.processGeneration,
            sequence,
            timestamp,
            event: preparedEvent.message,
            ...(preparedProperties.metadata === undefined
              ? {}
              : { properties: preparedProperties.metadata }),
            ...(identity === undefined ? {} : { identity }),
            truncated: preparedEvent.truncated || preparedProperties.truncated,
            malformed: preparedEvent.malformed || preparedProperties.malformed,
            ...context,
            ...override,
          }));
        } catch {
          // Analytics authoring is staged best-effort and never owns the mutation.
        }
      },
    });
  }

  commitAnalytics(events: readonly AnalyticsEventRecord[], commitVersion: bigint): void {
    for (const event of events) {
      this.journal.append(Object.freeze({ ...event, commitId: String(commitVersion) }));
    }
  }

  private createLogger(
    override?: Pick<ApplicationLogCallContext, "functionAddress" | "functionKind">,
  ): ApplicationLogger {
    const write = (
      level: ApplicationLogLevel,
      message: string,
      metadata?: TelemetryMetadata,
    ): void => {
      try {
        const sequence = ++this.sequence;
        const timestamp = this.now();
        const context = this.context();
        const preparedMessage = prepareTelemetryMessage(message);
        const preparedMetadata = prepareTelemetryMetadata(metadata);
        this.journal.append(Object.freeze({
          kind: "log",
          processGeneration: this.processGeneration,
          sequence,
          timestamp,
          level,
          message: preparedMessage.message,
          ...(preparedMetadata.metadata === undefined
            ? {}
            : { metadata: preparedMetadata.metadata }),
          truncated: preparedMessage.truncated || preparedMetadata.truncated,
          malformed: preparedMessage.malformed || preparedMetadata.malformed,
          ...context,
          ...override,
        }));
      } catch {
        // Application logging is deliberately total: malformed values and a
        // failed local journal must never escape into application code.
      }
    };
    return Object.freeze({
      debug: (message: string, metadata?: TelemetryMetadata) => write("debug", message, metadata),
      info: (message: string, metadata?: TelemetryMetadata) => write("info", message, metadata),
      warn: (message: string, metadata?: TelemetryMetadata) => write("warn", message, metadata),
      error: (message: string, metadata?: TelemetryMetadata) => write("error", message, metadata),
    });
  }
}
