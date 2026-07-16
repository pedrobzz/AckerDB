import { DbzzClient } from "@dbzz/client";
import { api } from "@demo/dbzz-codegen/api";

const client = new DbzzClient({
  url: process.env.DBZZ_URL ?? "http://127.0.0.1:3212",
  credential: { kind: "anonymous" },
});

try {
  const createdId = await client.mutation(api.tasks.create, { title: "Smoke check" });
  const afterCreate = await client.query(api.tasks.list, {});
  const created = afterCreate.find((task) => task.id === createdId);
  if (created === undefined) {
    throw new Error("created row was not returned by the list query");
  }

  await client.mutation(api.tasks.update, {
    id: createdId,
    title: created.title,
    completed: true,
  });
  const afterUpdate = await client.query(api.tasks.list, {});
  if (!afterUpdate.some((task) => task.id === createdId && task.completed)) {
    throw new Error("updated row was not returned by the list query");
  }

  await client.mutation(api.tasks.remove, { id: createdId });
  const afterRemove = await client.query(api.tasks.list, {});
  if (afterRemove.some((task) => task.id === createdId)) {
    throw new Error("removed row was still returned by the list query");
  }

  console.log("dbzz CRUD smoke check passed");
} finally {
  client.close();
}
