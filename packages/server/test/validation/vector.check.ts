import {
  defineSchema,
  defineTable,
  v,
  type InferValidator,
  type InferValidatorInput,
  type RowOf,
  type VectorValidator,
} from "@ackerdb/server";

const vector: VectorValidator = v.vector(3);
const input: InferValidatorInput<typeof vector> = [1, 2, 3] as const;
const value: InferValidator<typeof vector> = vector.parse(input, "embedding");

// @ts-expect-error normalized vector values are readonly
value.push(4);

const schema = defineSchema({
  documents: defineTable({ id: v.primaryKey(), embedding: v.vector(3) }),
});
declare const row: RowOf<typeof schema, "documents">;
const coordinate: number = row.embedding[0]!;
// @ts-expect-error Expand must retain vector readonlyness on public row shapes
row.embedding[0] = coordinate;

void value;
void coordinate;
