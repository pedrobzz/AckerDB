// Application input digest: 353cdd2cc48db21572bf0e65c54fb6534fb4e070faeceea01c7446e0ccf96598
import type * as module0 from "../backend/jobs/orders.ts";
import type * as module1 from "../backend/orders.ts";
import type * as module2 from "../backend/surfaces.ts";
import type * as module3 from "../backend/unsafe.ts";
import type * as module4 from "../backend/worker.ts";

type Kind = "function" | "job" | "lifecycle" | "http" | "channel" | "realtime" | "mcp";
type Declaration<K extends Kind> = { readonly __ackerKind: K };
type ExportsOfKind<M, K extends Kind> = {
  [P in keyof M as M[P] extends Declaration<K> ? P : never]: M[P]
};
export interface SourceModules {
  "jobs/orders.ts": typeof module0;
  "orders.ts": typeof module1;
  "surfaces.ts": typeof module2;
  "unsafe.ts": typeof module3;
  "worker.ts": typeof module4;
}
export type ClientFunctions = { [M in keyof SourceModules]: ExportsOfKind<SourceModules[M], "function"> };
export type ServerJobs = { [M in keyof SourceModules]: ExportsOfKind<SourceModules[M], "job"> };
export interface ServerContext { readonly jobs: ServerJobs }
