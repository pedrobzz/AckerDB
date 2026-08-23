/** Compile-time assertions for the approved validator constraint surface. */
import {
  v,
  type ArrayValidator,
  type BoundedValidator,
  type StringValidator,
} from "@ackerdb/server";

const stringValidator: StringValidator = v.string().describe("A label.").min(1).max(8).regex(/x/);
const intValidator: BoundedValidator<number, "int", number> = v.int().min(0.5).max(10);
const floatValidator: BoundedValidator<number, "float", number> = v.float().min(-1).max(1);
const bigintValidator: BoundedValidator<
  bigint,
  "bigint",
  bigint,
  bigint,
  number | string,
  string
> = v.bigint().min(0n).max(10n);
const arrayValidator: ArrayValidator<StringValidator> = v.array(v.string()).min(1).max(3);
void stringValidator;
void intValidator;
void floatValidator;
void bigintValidator;
void arrayValidator;

const terminal = v.string().min(1).nullable().describe("Nullable, but still terminal.");
// @ts-expect-error modifiers end constraint chaining
terminal.min(2);
// @ts-expect-error modifiers end constraint chaining
terminal.regex(/x/);
const optionalTerminal = v.int().min(0).optional().describe("Optional, and terminal.");
// @ts-expect-error optional ends constraint chaining
optionalTerminal.max(10);
const nullishTerminal = v.array(v.string()).max(3).nullish().describe("Nullish, and terminal.");
// @ts-expect-error nullish ends constraint chaining
nullishTerminal.min(1);
// @ts-expect-error regex accepts exactly one RegExp and no options
v.string().regex(/x/, {});
// @ts-expect-error arbitrary refinements are intentionally absent
v.string().refine(() => true);
// @ts-expect-error exact-length sugar is intentionally absent
v.string().length(2);
// @ts-expect-error numeric sugar is intentionally absent
v.int().positive();

// @ts-expect-error boolean has no constraints
v.boolean().min(1);
// @ts-expect-error bytes has no constraints
v.bytes().max(1);
// @ts-expect-error identity has no bigint range sugar
v.identity().min(1n);
// @ts-expect-error object has no constraints
v.object({ value: v.string() }).min(1);
// @ts-expect-error enum has no string constraints
v.enum("Role", ["admin"]).regex(/admin/);
// @ts-expect-error literal has no constraints
v.literal("x").min(1);
const discriminated = v.discriminatedUnion("type", [
  v.object({ type: v.literal("text"), value: v.string() }),
  v.object({ type: v.literal("none") }),
]);
// @ts-expect-error discriminated union has no constraints
discriminated.max(1);
// @ts-expect-error opaque JSON has no constraints
v.jsonb<unknown>().min(1);
// @ts-expect-error primary keys have no constraints
v.primaryKey().min(1n);
// @ts-expect-error schedule timestamps have no constraints
v.scheduleAt().min(0);
