import { AckerDBClient } from "@ackerdb/client";
import { api } from "@demo/ackerdb-codegen/api";
import { expectOk } from "./result.ts";

const client = new AckerDBClient({
  url: process.env.ACKERDB_URL ?? "http://127.0.0.1:3212",
  credential: {
    kind: "bearer",
    token: process.env.ACKERDB_DEMO_STAFF_TOKEN ?? "savoria-demo-staff",
  },
});

try {
  const result = expectOk(
    await client.mutation(api.setup.initialize, {}),
  );
  console.log(
    result.created
      ? "Restaurant demo data created"
      : "Restaurant demo data already exists",
  );
} finally {
  client.close();
}
