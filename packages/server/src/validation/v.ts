/**
 * The `v` validator DSL. Validators describe the runtime validation, the
 * TypeScript type and the storage form of every column, argument and return
 * value in a ackerdb app. They compose like Zod: validators nest inside arrays,
 * objects and discriminated unions, then finish with a nullable/optional/nullish modifier.
 */
import {
  bigint,
  boolean,
  bytes,
  file,
  fileGrant,
  float,
  identity,
  int,
  primaryKey,
  scheduleAt,
  string,
  vector,
} from "./primitives.ts";
import { array, discriminatedUnion, enum_, jsonb, literal, object } from "./composites.ts";

export const v = {
  primaryKey,
  string,
  int,
  float,
  bigint,
  identity,
  file,
  fileGrant,
  boolean,
  bytes,
  vector,
  array,
  object,
  enum: enum_,
  literal,
  discriminatedUnion,
  jsonb,
  scheduleAt,
};
