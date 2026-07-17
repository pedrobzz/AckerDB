/**
 * Schema definition: `defineTable`, `defineEventTable`, `defineSchema`.
 * A schema is validated eagerly — every rule violation throws at definition
 * time with a message naming the table/column/index at fault.
 */
import type { FunctionReference, RegisteredFunction } from "@dbzz/core";
import {
  ValidationError,
  type Descriptor,
  type Expand,
  type InferShape,
  type InferValidator,
  type ObjectShape,
  type Validator,
} from "./dbz.ts";
import {
  isAccessPolicy,
  validateArgsShape,
  type AccessPolicy,
} from "./functions.ts";
import { brand, hasBrand } from "./identity.ts";
import type { InvocationContext } from "./invocation.ts";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SCHEMA_IDENTITY = Symbol.for("@dbzz/server/Schema/v1");
const TABLE_DEF_IDENTITY = Symbol.for("@dbzz/server/TableDef/v1");

function checkName(name: string, what: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new ValidationError(`${what} "${name}" must match ${IDENTIFIER}`);
  }
  if (name.includes("__")) {
    throw new ValidationError(`${what} "${name}" must not contain "__" (reserved)`);
  }
}

/** Unwrap nullable to the underlying validator. */
function unwrap(validator: Validator<unknown, string>): Validator<unknown, string> {
  return validator.kind === "nullable"
    ? (validator as unknown as { inner: Validator<unknown, string> }).inner
    : validator;
}

const INDEXABLE = new Set(["string", "number", "bigint", "identity", "boolean", "enum", "union", "scheduleAt"]);
const DIRECT_INDEXABLE = new Set(["bigint", "identity", "enum", "union"]);

export interface IndexOptions {
  unique?: boolean;
  algorithm?: "btree" | "direct";
}

export interface IndexDef {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly algorithm: "btree" | "direct";
}

/** A mutation to run atomically with deletion when a scheduled row comes due. */
export type ScheduledHandler =
  | FunctionReference<"mutation">
  | RegisteredFunction<"mutation", unknown, unknown>
  | string;

export interface EventSubscriptionDefinition<
  Cols extends ObjectShape,
  Args extends ObjectShape,
> {
  readonly args: Args;
  readonly access: AccessPolicy<InvocationContext, Expand<InferShape<Args>>>;
  readonly matches: (
    row: Readonly<RowShape<Cols>>,
    args: Readonly<Expand<InferShape<Args>>>,
  ) => boolean;
}

interface RuntimeEventSubscriptionDefinition {
  readonly args: ObjectShape;
  readonly access: AccessPolicy<InvocationContext, unknown>;
  readonly matches: (row: unknown, args: unknown) => boolean;
}

type IndexMeta = { columns: readonly string[]; unique: boolean };

export class TableDef<
  Cols extends ObjectShape = ObjectShape,
  // eslint-disable-next-line @typescript-eslint/ban-types
  Ixs extends Record<string, IndexMeta> = {},
  Kind extends "table" | "event" = "table" | "event",
  EventArgs extends ObjectShape = ObjectShape,
> {
  readonly columns: Cols;
  readonly kind: Kind;
  readonly indexes: IndexDef[] = [];
  scheduledHandler: ScheduledHandler | null = null;
  readonly eventSubscription: RuntimeEventSubscriptionDefinition | null;
  /** Type-only carrier used by EventArgsOf. */
  readonly _eventArgsType?: EventArgs;

  constructor(
    columns: Cols,
    kind: Kind,
    eventSubscription: EventSubscriptionDefinition<Cols, EventArgs> | null = null,
  ) {
    brand(this, TABLE_DEF_IDENTITY);
    this.columns = columns;
    this.kind = kind;
    this.eventSubscription = eventSubscription as RuntimeEventSubscriptionDefinition | null;
    let pkCount = 0;
    let scheduleAtCount = 0;
    for (const [name, validator] of Object.entries(columns)) {
      checkName(name, "column");
      if (validator.kind === "pk") pkCount++;
      if (validator.kind === "scheduleAt") scheduleAtCount++;
      if (validator.kind === "tag") {
        throw new ValidationError(`column "${name}": dbz.tag() is only valid inside a union`);
      }
    }
    if (pkCount !== 1) {
      throw new ValidationError(
        `every table must have exactly one dbz.primaryKey() column (found ${pkCount})`,
      );
    }
    if (scheduleAtCount > 1) {
      throw new ValidationError("a table may have at most one dbz.scheduleAt() column");
    }
    if (kind === "event" && scheduleAtCount > 0) {
      throw new ValidationError("event tables cannot have a dbz.scheduleAt() column");
    }
  }

  get primaryKey(): string {
    return Object.keys(this.columns).find((c) => this.columns[c]!.kind === "pk")!;
  }

  get scheduleAtColumn(): string | null {
    return Object.keys(this.columns).find((c) => this.columns[c]!.kind === "scheduleAt") ?? null;
  }

  index<
    const N extends string,
    const C extends readonly (keyof Cols & string)[],
    const O extends IndexOptions = Record<never, never>,
  >(
    name: N,
    columns: C,
    opts?: O,
  ): TableDef<
    Cols,
    Ixs & Record<N, { columns: C; unique: O["unique"] extends true ? true : false }>,
    Kind,
    EventArgs
  > {
    checkName(name, "index");
    if (this.kind === "event") {
      throw new ValidationError(
        `index "${name}": event tables never persist rows, so an index could never be used`,
      );
    }
    if (this.indexes.some((ix) => ix.name === name)) {
      throw new ValidationError(`duplicate index name "${name}"`);
    }
    if (columns.length === 0) throw new ValidationError(`index "${name}": no columns`);
    if (new Set(columns).size !== columns.length) {
      throw new ValidationError(`index "${name}": duplicate columns`);
    }
    for (const column of columns) {
      const validator = this.columns[column];
      if (!validator) throw new ValidationError(`index "${name}": unknown column "${column}"`);
      if (validator.kind === "pk") {
        throw new ValidationError(
          `index "${name}": the primary key is already the table's storage key; indexing it is redundant`,
        );
      }
      const inner = unwrap(validator);
      if (!INDEXABLE.has(inner.kind)) {
        throw new ValidationError(
          `index "${name}": column "${column}" (${inner.kind}) is not indexable — promote the field you need into its own scalar column`,
        );
      }
    }
    const algorithm = opts?.algorithm ?? "btree";
    if (algorithm === "direct") {
      if (columns.length !== 1) {
        throw new ValidationError(`index "${name}": direct indexes are single-column`);
      }
      const validator = this.columns[columns[0]!]!;
      if (!DIRECT_INDEXABLE.has(validator.kind)) {
        throw new ValidationError(
          `index "${name}": direct indexes need a dense non-negative integer column (bigint, identity, enum or union tag)`,
        );
      }
    }
    this.indexes.push({ name, columns, unique: opts?.unique ?? false, algorithm });
    return this as unknown as TableDef<
      Cols,
      Ixs & Record<N, { columns: C; unique: O["unique"] extends true ? true : false }>,
      Kind,
      EventArgs
    >;
  }

  scheduled(handler: ScheduledHandler): this {
    if (this.kind === "event") {
      throw new ValidationError("event tables cannot be scheduled");
    }
    if (this.scheduleAtColumn === null) {
      throw new ValidationError(".scheduled(...) requires a dbz.scheduleAt() column");
    }
    if (this.scheduledHandler !== null) {
      throw new ValidationError("table already has a scheduled handler");
    }
    this.scheduledHandler = handler;
    return this;
  }
}

/** True for a table definition created by any compatible @dbzz/server instance. */
export function isTableDef(value: unknown): value is TableDef {
  return hasBrand(value, TABLE_DEF_IDENTITY);
}

export function defineTable<Cols extends ObjectShape>(
  columns: Cols,
): TableDef<Cols, Record<never, never>, "table"> {
  return new TableDef(columns, "table");
}

export function defineEventTable<Cols extends ObjectShape, Args extends ObjectShape>(
  columns: Cols,
  subscription: EventSubscriptionDefinition<Cols, Args>,
): TableDef<Cols, Record<never, never>, "event", Args> {
  if (subscription === undefined || subscription === null || typeof subscription !== "object") {
    throw new TypeError("event table subscription metadata is required");
  }
  if (!isAccessPolicy(subscription.access)) {
    throw new TypeError(
      "event subscription access must be public, authenticated, system, or a policy callback",
    );
  }
  if (
    typeof subscription.args !== "object" ||
    subscription.args === null ||
    Array.isArray(subscription.args)
  ) {
    throw new TypeError("event subscription args must be an object shape");
  }
  validateArgsShape(subscription.args, "event args");
  if (typeof subscription.matches !== "function") {
    throw new TypeError("event subscription matches must be a function");
  }
  return new TableDef(columns, "event", Object.freeze({ ...subscription }));
}

/** Turn a table name into its generated row type name: PascalCase + singularized last word. */
export function rowTypeName(table: string): string {
  const words = table.split(/_|(?=[A-Z])/).filter((w) => w.length > 0);
  const last = words[words.length - 1]!;
  words[words.length - 1] = singularize(last);
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
}

export function eventArgsTypeName(table: string): string {
  return `${rowTypeName(table)}Args`;
}

function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith("ies") && word.length > 3) return `${word.slice(0, -3)}${word[1] === word[1]!.toUpperCase() ? "Y" : "y"}`;
  if (/(ses|xes|zes|ches|shes)$/.test(lower)) return word.slice(0, -2);
  if (lower.endsWith("s") && !lower.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Runtime version of the type-level CamelCase: "by_channel_time" -> "byChannelTime". */
export function camelCase(snake: string): string {
  return snake.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

export type CamelCase<S extends string> = S extends `${infer H}_${infer T}`
  ? `${H}${Capitalize<CamelCase<T>>}`
  : S;

export class Schema<T extends Record<string, TableDef> = Record<string, TableDef>> {
  readonly tables: T;
  /** Named enum/union validators, by declared name. */
  readonly namedTypes: ReadonlyMap<string, Validator<unknown, string>>;

  constructor(tables: T, namedTypes: Map<string, Validator<unknown, string>>) {
    brand(this, SCHEMA_IDENTITY);
    this.tables = tables;
    this.namedTypes = namedTypes;
  }
}

/** True for a schema created by any compatible @dbzz/server instance. */
export function isSchema(value: unknown): value is Schema {
  return hasBrand(value, SCHEMA_IDENTITY);
}

export function defineSchema<T extends Record<string, TableDef>>(tables: T): Schema<T> {
  const namedTypes = new Map<string, Validator<unknown, string>>();
  const namedDescriptors = new Map<string, string>();
  const typeNames = new Map<string, string>(); // generated type name -> "table x" | "enum y"

  const claimTypeName = (name: string, owner: string) => {
    const existing = typeNames.get(name);
    if (existing !== undefined) {
      throw new ValidationError(
        `generated type name "${name}" collides: ${existing} and ${owner} — rename one`,
      );
    }
    typeNames.set(name, owner);
  };

  const walk = (validator: Validator<unknown, string>, where: string, context: "column" | "nested") => {
    switch (validator.kind) {
      case "pk":
        if (context !== "column") throw new ValidationError(`${where}: dbz.primaryKey() must be a top-level column`);
        return;
      case "scheduleAt":
        if (context !== "column") throw new ValidationError(`${where}: dbz.scheduleAt() must be a top-level column`);
        return;
      case "tag":
        throw new ValidationError(`${where}: dbz.tag() is only valid inside a union`);
      case "nullable":
        walk((validator as { inner?: Validator<unknown, string> }).inner!, where, context);
        return;
      case "array":
        walk((validator as { element?: Validator<unknown, string> }).element!, `${where}[]`, "nested");
        return;
      case "object": {
        const shape = (validator as { shape?: ObjectShape }).shape!;
        for (const key of Object.keys(shape)) walk(shape[key]!, `${where}.${key}`, "nested");
        return;
      }
      case "enum":
      case "union": {
        const name = (validator as { name?: string }).name!;
        checkName(name, "type name");
        const descriptor = JSON.stringify(validator.descriptor());
        const existing = namedDescriptors.get(name);
        if (existing === undefined) {
          namedDescriptors.set(name, descriptor);
          namedTypes.set(name, validator);
          claimTypeName(name, `${validator.kind} "${name}"`);
        } else if (existing !== descriptor) {
          throw new ValidationError(
            `${where}: ${validator.kind} name "${name}" is declared twice with different definitions`,
          );
        }
        if (validator.kind === "union") {
          const members = (validator as { members?: Record<string, Validator<unknown, string>> }).members!;
          for (const variant of Object.keys(members)) {
            checkName(variant, "union variant");
            const member = members[variant]!;
            if (member.kind === "tag") continue;
            walk(member, `${where}<${variant}>`, "nested");
          }
        }
        return;
      }
      default:
        return;
    }
  };

  for (const [tableName, table] of Object.entries(tables)) {
    checkName(tableName, "table name");
    if (!isTableDef(table)) {
      throw new ValidationError(`table "${tableName}" is not a defineTable(...) result`);
    }
    if (table.scheduleAtColumn !== null && table.scheduledHandler === null) {
      throw new ValidationError(
        `table "${tableName}" has a dbz.scheduleAt() column but no .scheduled(handler)`,
      );
    }
    claimTypeName(rowTypeName(tableName), `table "${tableName}"`);
    for (const [column, validator] of Object.entries(table.columns)) {
      walk(validator, `${tableName}.${column}`, "column");
    }
    if (table.kind === "event") {
      claimTypeName(eventArgsTypeName(tableName), `event args for table "${tableName}"`);
      for (const [name, validator] of Object.entries(table.eventSubscription!.args)) {
        walk(validator, `${tableName}.eventArgs.${name}`, "nested");
      }
    }
  }

  return new Schema(tables, namedTypes);
}

// ---------------------------------------------------------------------------
// Type utilities shared by ctx.db typing and codegen.

export type TableColumns<TD> = TD extends TableDef<infer C, Record<string, IndexMeta>, "table" | "event", ObjectShape>
  ? C
  : never;
export type TableIndexes<TD> = TD extends TableDef<ObjectShape, infer I, "table" | "event", ObjectShape> ? I : never;
export type TableKind<TD> = TD extends TableDef<ObjectShape, Record<string, IndexMeta>, infer K, ObjectShape>
  ? K
  : never;
export type { IndexMeta };

export type RowShape<C extends ObjectShape> = Expand<{ [K in keyof C]: InferValidator<C[K]> }>;

type PkKeys<C extends ObjectShape> = {
  [K in keyof C]: C[K] extends Validator<unknown, "pk"> ? K : never;
}[keyof C];
type NullableKeys<C extends ObjectShape> = {
  [K in keyof C]: C[K] extends Validator<unknown, "nullable"> ? K : never;
}[keyof C];

/** Insert shape: primary key omitted, nullable columns optional. */
export type InsertShape<C extends ObjectShape> = Expand<
  {
    [K in Exclude<keyof C, PkKeys<C> | NullableKeys<C>>]: InferValidator<C[K]>;
  } & {
    [K in Extract<NullableKeys<C>, keyof C>]?: InferValidator<C[K]> | null;
  }
>;

/** Patch shape: every non-pk column optional; `undefined` means untouched. */
export type PatchShape<C extends ObjectShape> = Expand<{
  [K in Exclude<keyof C, PkKeys<C>>]?: InferValidator<C[K]>;
}>;

export type SchemaTables<S> = S extends Schema<infer T> ? T : never;

/** The exact row type of a table, as generated codegen types use it. */
export type RowOf<S, T extends keyof SchemaTables<S>> = RowShape<TableColumns<SchemaTables<S>[T]>>;

/** Caller input accepted by an event table's subscription argument schema. */
export type EventArgsOf<S, T extends keyof SchemaTables<S>> =
  SchemaTables<S>[T] extends TableDef<ObjectShape, Record<string, IndexMeta>, "event", infer A>
    ? InsertShape<A>
    : never;
