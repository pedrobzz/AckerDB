// Application input digest: 2a1f2be9a6681fc482cc6bab65d32ee4a4505347cacb4f275f6d4502f836ef0d
import type * as module0 from "../backend/jobs/orders.ts";
import type * as module1 from "../backend/orders.ts";
import type * as module2 from "../backend/surfaces.ts";
import type * as module3 from "../backend/unsafe.ts";
import type * as module4 from "../backend/worker.ts";

export interface ClientFunctions {
  "api.orders.read": typeof module1["read"];
  "api.orders.submit": typeof module1["submit"];
}

export interface ServerJobs {
  "jobs.orders.refresh": typeof module0["refresh"];
}

export interface ServerContext { readonly jobs: ServerJobs }
