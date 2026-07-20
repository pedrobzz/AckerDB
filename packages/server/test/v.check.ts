/** Compile-time assertions for validator modifier key semantics. */
import {
  v,
  type InferInputShape,
  type InferShape,
} from "@dbzz/server";

const fields = {
  required: v.string(),
  nullable: v.string().nullable(),
  optional: v.string().optional(),
  nullish: v.string().nullish(),
};

type Input = InferInputShape<typeof fields>;
type Output = InferShape<typeof fields>;

const minimalInput: Input = { required: "set", nullable: null };
const explicitInput: Input = {
  required: "set",
  nullable: "set",
  optional: undefined,
  nullish: null,
};
const minimalOutput: Output = { required: "set", nullable: null };
const explicitOutput: Output = {
  required: "set",
  nullable: "set",
  optional: undefined,
  nullish: null,
};
void minimalInput;
void explicitInput;
void minimalOutput;
void explicitOutput;

// @ts-expect-error nullable is a required key even though its value may be null
const missingNullable: Input = { required: "set" };
// @ts-expect-error optional accepts undefined or a string, never null
const nullOptional: Input = { required: "set", nullable: null, optional: null };
void missingNullable;
void nullOptional;

const terminal = v.string().nullable();
// @ts-expect-error modifiers are terminal; nullish is the sole nullable+optional spelling
terminal.optional();
