import { DbzzClient } from "@dbzz/client";
import { api } from "@demo/dbzz-codegen/api";
import { expectOk } from "./result.ts";

const client = new DbzzClient({
  url: process.env.DBZZ_URL ?? "http://127.0.0.1:3212",
  credential: {
    kind: "bearer",
    token: process.env.DBZZ_DEMO_STAFF_TOKEN ?? "savoria-demo-staff",
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
