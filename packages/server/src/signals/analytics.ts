import { totalSignal } from "./delivery.ts";

export type AnalyticsProperties = Readonly<Record<string, unknown>>;

export interface AnalyticsStrategy {
  track(event: string, properties?: AnalyticsProperties): void;
}

export const consoleAnalyticsStrategy: AnalyticsStrategy = Object.freeze({
  track(event: string, properties?: AnalyticsProperties): void {
    if (properties === undefined) {
      console.log(`[analytics] ${event}`);
      return;
    }
    console.log(`[analytics] ${event}`, properties);
  },
});

export class Analytics {
  readonly track: (event: string, properties?: AnalyticsProperties) => void;

  constructor(strategy: AnalyticsStrategy = consoleAnalyticsStrategy) {
    this.track = totalSignal((event, properties) => strategy.track(event, properties));
  }
}
