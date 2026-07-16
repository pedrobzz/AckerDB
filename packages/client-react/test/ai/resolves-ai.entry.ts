// Control entry for the import-isolation test: a graph that really does
// resolve the AI SDK at runtime, proving the bundle markers the test greps
// for actually appear when `ai` is included.
export { createUIMessageStream } from "ai";
