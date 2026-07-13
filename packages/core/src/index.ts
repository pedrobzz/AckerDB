export { encode, decode, stableEncode, WireError } from "./wire.ts";
export {
  anyApi,
  getRef,
  type FunctionKind,
  type FunctionReference,
  type QueryRef,
  type MutationRef,
  type ProcedureRef,
  type SseRef,
  type EventRef,
  type RegisteredFunction,
  type ApiFromModules,
} from "./refs.ts";
export * from "./protocol.ts";
