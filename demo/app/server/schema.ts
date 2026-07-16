import { dbz, defineSchema, defineTable } from "@dbzz/server";

export default defineSchema({
  tasks: defineTable({
    id: dbz.primaryKey(),
    title: dbz.string(),
    completed: dbz.boolean(),
  }),
});
