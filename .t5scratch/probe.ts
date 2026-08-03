import { v, defineSchema, defineTable, Engine } from "@ackerdb/server";
for (const [label, make] of [
  ["literal", () => v.literal(1)],
  ["tag", () => v.tag()],
] as const) {
  try {
    const s = defineSchema({ t: defineTable({ id: v.primaryKey(), x: make() as never }) });
    try { new Engine(s, ":memory:"); console.log(label, "-> engine OK"); }
    catch (e) { console.log(label, "-> engine:", (e as Error).constructor.name, (e as Error).message); }
  } catch (e) { console.log(label, "-> defineTable:", (e as Error).constructor.name, (e as Error).message); }
}
