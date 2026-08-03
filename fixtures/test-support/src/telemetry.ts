export const noopLogger = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

export const noopAnalytics = Object.freeze({ track: () => {} });
