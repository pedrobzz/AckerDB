// Application input digest: 353cdd2cc48db21572bf0e65c54fb6534fb4e070faeceea01c7446e0ccf96598
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
