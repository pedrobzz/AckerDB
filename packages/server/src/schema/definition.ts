/**
 * Schema definition: `defineTable`, `defineEventTable`, `defineSchema`.
 * A schema is validated eagerly — every rule violation throws at definition
 * time with a message naming the table/column/index at fault.
 */
import { ValidationError } from "../validation/error.ts";
import {
  baseValidator,
  type Descriptor,
  type Expand,
  type InferValidator,
  type Validator,
} from "../validation/validator.ts";
import {
  object,
  type InferInputShape,
  type InferShape,
  type ObjectShape,
  type ObjectValidator,
} from "../validation/composites.ts";
import {
  isAccessPolicy,
  type AccessPolicy,
  type InvocationContext,
} from "../app/access.ts";
import { brand, hasBrand } from "../shared/identity.ts";
import { sqlTypeOf } from "./descriptor-kinds.ts";

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SCHEMA_IDENTITY = Symbol.for("@ackerdb/server/Schema/v1");
const TABLE_DEF_IDENTITY = Symbol.for("@ackerdb/server/TableDef/v1");

function checkName(name: string, what: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new ValidationError(`${what} "${name}" must match ${IDENTIFIER}`);
  }
  if (name.includes("__")) {
    throw new ValidationError(`${what} "${name}" must not contain "__" (reserved)`);
  }
}

function assertStoredValidator(
  validator: Validator<unknown, string>,
  where: string,
  directColumn = false,
): void {
  if (validator.kind === "optional" || validator.kind === "nullish") {
    throw new ValidationError(
      `${where}: .${validator.kind}() is not valid in stored data; use .nullable() for nullable storage`,
    );
  }
  if (validator.kind === "nullable") {
    assertStoredValidator(
      (validator as unknown as { readonly inner: Validator<unknown, string> }).inner,
      where,
      directColumn,
    );
    return;
  }
  // A direct column must have a physical layout: its own SQLite type, or the
  // custom primary-key layout. Refuse here, at definition time with the column
  // named, rather than deep inside plan construction.
  if (directColumn && validator.kind !== "pk") {
    if (sqlTypeOf(validator.kind) === undefined) {
      throw new ValidationError(`${where}: v.${validator.kind}() has no column storage`);
    }
  }
  if (validator.kind === "vector") {
    if (!directColumn) {
      throw new ValidationError(
        `${where}: v.vector() may only be stored as a direct column, optionally nullable`,
      );
    }
    return;
  }
  if (validator.kind === "file" || validator.kind === "fileGrant") {
    if (!directColumn) {
      throw new ValidationError(
        `${where}: v.${validator.kind}() may only be stored as a direct column, optionally nullable`,
      );
    }
    return;
  }
  if (validator.kind === "array") {
    assertStoredValidator(
      (validator as unknown as { readonly element: Validator<unknown, string> }).element,
      `${where}[]`,
      false,
    );
    return;
  }
  if (validator.kind === "object") {
    const shape = (validator as unknown as { readonly shape: ObjectShape }).shape;
    for (const [name, field] of Object.entries(shape)) {
      assertStoredValidator(field, `${where}.${name}`);
    }
    return;
  }
  if (validator.kind === "discriminatedUnion") {
    const members = (validator as unknown as {
      readonly members: readonly Validator<unknown, string>[];
    }).members;
    for (const [index, member] of members.entries()) {
      assertStoredValidator(member, `${where}[${index}]`);
    }
  }
}

const INDEXABLE = new Set(["string", "int", "float", "bigint", "identity", "file", "fileGrant", "boolean", "enum", "discriminatedUnion", "scheduleAt"]);

export interface IndexOptions {
  unique?: boolean;
}

export interface IndexDef {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

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
  readonly args: ObjectValidator<ObjectShape>;
  readonly access: AccessPolicy<InvocationContext, unknown>;
  readonly matches: (row: unknown, args: unknown) => boolean;
}

export type IndexMeta = {
  readonly columns: readonly string[];
  readonly unique: boolean;
};

type FullTextColumnKey<Cols extends ObjectShape> = {
  [K in keyof Cols & string]:
    Cols[K] extends { readonly kind: "string" }
      ? K
      : Cols[K] extends {
          readonly kind: "nullable";
          readonly inner: { readonly kind: "string" };
        }
        ? K
        : never;
}[keyof Cols & string];

/**
 * Stable structural identity for an index within a physical table. Column
 * lengths make the encoding injective without retaining a public name.
 */
function structuralIndexName(
  columns: readonly string[],
  unique: boolean,
): string {
  const encodedColumns = columns.map((column) => `${column.length}_${column}`).join("_");
  return `s_${unique ? "u" : "n"}_${encodedColumns}`;
}

export class TableDef<
  Cols extends ObjectShape = ObjectShape,
  Ixs extends readonly IndexMeta[] = readonly IndexMeta[],
  Kind extends "table" | "event" = "table" | "event",
  EventArgs extends ObjectShape = ObjectShape,
  FullText extends readonly string[] = readonly string[],
> {
  readonly columns: Cols;
  readonly kind: Kind;
  readonly indexes: IndexDef[] = [];
  readonly fullTextColumns: string[] = [];
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
    this.eventSubscription = eventSubscription === null
      ? null
      : {
          ...eventSubscription,
          args: object(eventSubscription.args),
        } as RuntimeEventSubscriptionDefinition;
    let pkCount = 0;
    let scheduleAtCount = 0;
    for (const [name, validator] of Object.entries(columns)) {
      checkName(name, "column");
      assertStoredValidator(validator, `column "${name}"`, true);
      if (validator.kind === "pk") pkCount++;
      if (validator.kind === "scheduleAt") scheduleAtCount++;
    }
    if (pkCount !== 1) {
      throw new ValidationError(
        `every table must have exactly one v.primaryKey() column (found ${pkCount})`,
      );
    }
    if (scheduleAtCount > 1) {
      throw new ValidationError("a table may have at most one v.scheduleAt() column");
    }
    if (kind === "event" && scheduleAtCount > 0) {
      throw new ValidationError("event tables cannot have a v.scheduleAt() column");
    }
  }

  get primaryKey(): string {
    return Object.keys(this.columns).find((c) => this.columns[c]!.kind === "pk")!;
  }

  get scheduleAtColumn(): string | null {
    return Object.keys(this.columns).find((c) => this.columns[c]!.kind === "scheduleAt") ?? null;
  }

  index<
    const C extends readonly (keyof Cols & string)[],
    const O extends IndexOptions = Record<never, never>,
  >(
    columns: C,
    opts?: O,
  ): TableDef<
    Cols,
    readonly [
      ...Ixs,
      {
        columns: C;
        unique: O["unique"] extends true ? true : false;
      },
    ],
    Kind,
    EventArgs,
    FullText
  > {
    if (this.kind === "event") {
      throw new ValidationError(
        "index: event tables never persist rows, so an index could never be used",
      );
    }
    if (columns.length === 0) throw new ValidationError("index: no columns");
    if (new Set(columns).size !== columns.length) {
      throw new ValidationError("index: duplicate columns");
    }
    if (
      this.indexes.some(
        (index) =>
          index.columns.length === columns.length &&
          index.columns.every((column, position) => column === columns[position]),
      )
    ) {
      throw new ValidationError(
        `duplicate index columns [${columns.map((column) => JSON.stringify(column)).join(", ")}]`,
      );
    }
    for (const column of columns) {
      if (!Object.hasOwn(this.columns, column)) {
        throw new ValidationError(`index: unknown column "${column}"`);
      }
      const validator = this.columns[column]!;
      if (validator.kind === "pk") {
        throw new ValidationError(
          "index: the primary key is already the table's storage key; indexing it is redundant",
        );
      }
      const inner = baseValidator(validator);
      if (!INDEXABLE.has(inner.kind)) {
        throw new ValidationError(
          `index: column "${column}" (${inner.kind}) is not indexable — promote the field you need into its own scalar column`,
        );
      }
    }
    const unique = opts?.unique ?? false;
    const name = structuralIndexName(columns, unique);
    this.indexes.push({ name, columns, unique });
    return this as unknown as TableDef<
      Cols,
      readonly [
        ...Ixs,
        {
          columns: C;
          unique: O["unique"] extends true ? true : false;
        },
      ],
      Kind,
      EventArgs,
      FullText
    >;
  }

  fullText<const C extends readonly FullTextColumnKey<Cols>[]>(
    columns: C,
  ): TableDef<Cols, Ixs, Kind, EventArgs, C> {
    if (this.kind === "event") {
      throw new ValidationError(
        "fullText: event tables never persist rows, so a full-text index could never be used",
      );
    }
    if (this.fullTextColumns.length > 0) {
      throw new ValidationError("table already has a full-text declaration");
    }
    if (columns.length === 0) throw new ValidationError("fullText: no columns");
    if (new Set(columns).size !== columns.length) {
      throw new ValidationError("fullText: duplicate columns");
    }
    for (const column of columns) {
      if (!Object.hasOwn(this.columns, column)) {
        throw new ValidationError(`fullText: unknown column "${column}"`);
      }
      if (column.toLowerCase() === "rank" || column.toLowerCase() === "rowid") {
        throw new ValidationError(
          `fullText: column name "${column}" is reserved by FTS5`,
        );
      }
      const kind = baseValidator(this.columns[column]!).kind;
      if (kind !== "string") {
        throw new ValidationError(
          `fullText: column "${column}" (${kind}) is not a string`,
        );
      }
    }
    this.fullTextColumns.push(...columns);
    return this as unknown as TableDef<Cols, Ixs, Kind, EventArgs, C>;
  }
}

/** True for a table definition created by any compatible @ackerdb/server instance. */
export function isTableDef(value: unknown): value is TableDef {
  return hasBrand(value, TABLE_DEF_IDENTITY);
}

export function defineTable<Cols extends ObjectShape>(
  columns: Cols,
): TableDef<Cols, readonly [], "table", ObjectShape, readonly []> {
  return new TableDef(columns, "table");
}

export function defineEventTable<Cols extends ObjectShape, Args extends ObjectShape>(
  columns: Cols,
  subscription: EventSubscriptionDefinition<Cols, Args>,
): TableDef<Cols, readonly [], "event", Args, readonly []> {
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

export class Schema<T extends Record<string, TableDef> = Record<string, TableDef>> {
  readonly tables: T;
  /** Validators that codegen emits as named aliases. */
  readonly namedTypes: ReadonlyMap<string, Validator<unknown, string>>;

  constructor(tables: T, namedTypes: Map<string, Validator<unknown, string>>) {
    brand(this, SCHEMA_IDENTITY);
    this.tables = tables;
    this.namedTypes = namedTypes;
  }
}

/** True for a schema created by any compatible @ackerdb/server instance. */
export function isSchema(value: unknown): value is Schema {
  return hasBrand(value, SCHEMA_IDENTITY);
}

/**
 * Merge schema contributions into one schema, refusing every collision.
 *
 * Composition is the one way two declared table sets ever meet — the framework
 * schema is assembled from its domain modules' contributions, and the root
 * schema is that composition beside the application's. Both table names and
 * generated types must be unique across contributions: a silent
 * overwrite would let one contribution answer for another's rows, and the
 * failure would surface as a decode error long after the schema was built.
 *
 * A named type declared identically by two contributions is not a conflict —
 * `defineSchema` already interns one validator per name, and two contributions
 * that agree byte for byte describe the same type.
 */
export function composeSchemas(contributions: readonly Schema[], where: string): Schema {
  const tables: Record<string, TableDef> = {};
  const owners = new Map<string, number>();
  const namedTypes = new Map<string, Validator<unknown, string>>();
  const namedDescriptors = new Map<string, string>();
  contributions.forEach((contribution, index) => {
    if (!isSchema(contribution)) {
      throw new ValidationError(`${where}: contribution ${index} is not a schema`);
    }
    for (const [name, table] of Object.entries(contribution.tables)) {
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new ValidationError(
          `${where}: table "${name}" is declared by contributions ${owner} and ${index}`,
        );
      }
      owners.set(name, index);
      tables[name] = table;
    }
    for (const [name, validator] of contribution.namedTypes) {
      const descriptor = JSON.stringify(validator.descriptor());
      const existing = namedDescriptors.get(name);
      if (existing === undefined) {
        namedDescriptors.set(name, descriptor);
        namedTypes.set(name, validator);
      } else if (existing !== descriptor) {
        throw new ValidationError(
          `${where}: named type "${name}" is declared twice with different definitions`,
        );
      }
    }
  });
  return new Schema(tables, namedTypes);
}

export function defineSchema<T extends Record<string, TableDef>>(tables: T): Schema<T> {
  const namedTypes = new Map<string, Validator<unknown, string>>();
  const namedDescriptors = new Map<string, string>();
  const typeNames = new Map<string, string>(); // generated type name -> "table x" | "enum y"

  const derivedTypeName = (address: string): string => {
    const words = address.match(/[a-zA-Z0-9]+/g) ?? [];
    return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
  };

  const claimTypeName = (name: string, owner: string) => {
    const existing = typeNames.get(name);
    if (existing !== undefined) {
      throw new ValidationError(
        `generated type name "${name}" collides: ${existing} and ${owner} — rename one`,
      );
    }
    typeNames.set(name, owner);
  };

  const walk = (
    validator: Validator<unknown, string>,
    where: string,
    context: "column" | "nested",
    stored: boolean,
  ) => {
    switch (validator.kind) {
      case "pk":
        if (context !== "column") throw new ValidationError(`${where}: v.primaryKey() must be a top-level column`);
        return;
      case "scheduleAt":
        if (context !== "column") throw new ValidationError(`${where}: v.scheduleAt() must be a top-level column`);
        return;
      case "nullable":
        walk((validator as { inner?: Validator<unknown, string> }).inner!, where, context, stored);
        return;
      case "optional":
      case "nullish":
        if (stored) {
          throw new ValidationError(
            `${where}: .${validator.kind}() is not valid in stored data; use .nullable() for nullable storage`,
          );
        }
        walk((validator as { inner?: Validator<unknown, string> }).inner!, where, context, false);
        return;
      case "array":
        walk(
          (validator as { element?: Validator<unknown, string> }).element!,
          `${where}[]`,
          "nested",
          stored,
        );
        return;
      case "object": {
        const shape = (validator as { shape?: ObjectShape }).shape!;
        for (const key of Object.keys(shape)) {
          walk(shape[key]!, `${where}.${key}`, "nested", stored);
        }
        return;
      }
      case "enum": {
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
        return;
      }
      case "discriminatedUnion": {
        const union = validator as unknown as {
          codegenName?: string;
          discriminator: string;
          members: readonly ObjectValidator[];
        };
        const name = union.codegenName ?? derivedTypeName(where);
        checkName(name, "generated union type name");
        const descriptor = JSON.stringify(validator.descriptor());
        const existing = namedDescriptors.get(name);
        if (existing === undefined) {
          namedDescriptors.set(name, descriptor);
          namedTypes.set(name, validator);
          claimTypeName(name, `discriminated union at ${where}`);
        } else if (existing !== descriptor) {
          throw new ValidationError(
            `${where}: generated discriminated-union name "${name}" is already used by a different definition`,
          );
        }
        for (const member of union.members) {
          const literal = member.shape[union.discriminator] as unknown as { value: string };
          walk(member, `${where}.${literal.value}`, "nested", stored);
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
    if (table.scheduleAtColumn !== null) {
      throw new ValidationError(
        `table "${tableName}": v.scheduleAt() is framework-internal; durable work is declared with job() in a definition module`,
      );
    }
    claimTypeName(rowTypeName(tableName), `table "${tableName}"`);
    for (const [column, validator] of Object.entries(table.columns)) {
      walk(validator, `${tableName}.${column}`, "column", true);
    }
    if (table.kind === "event") {
      claimTypeName(eventArgsTypeName(tableName), `event args for table "${tableName}"`);
      for (const [name, validator] of Object.entries(table.eventSubscription!.args.shape)) {
        walk(validator, `${tableName}.eventArgs.${name}`, "nested", false);
      }
    }
  }

  return new Schema(tables, namedTypes);
}

// ---------------------------------------------------------------------------
// Type utilities shared by ctx.db typing and codegen.

export type TableColumns<TD> = TD extends TableDef<
  infer C,
  readonly IndexMeta[],
  "table" | "event",
  ObjectShape,
  readonly string[]
>
  ? C
  : never;
export type TableIndexes<TD> = TD extends TableDef<
  ObjectShape,
  infer I,
  "table" | "event",
  ObjectShape,
  readonly string[]
>
  ? I
  : never;
export type TableFullTextColumns<TD> = TD extends TableDef<
  ObjectShape,
  readonly IndexMeta[],
  "table" | "event",
  ObjectShape,
  infer FullText
>
  ? FullText
  : never;
export type TableKind<TD> = TD extends TableDef<
  ObjectShape,
  readonly IndexMeta[],
  infer K,
  ObjectShape,
  readonly string[]
>
  ? K
  : never;

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
  SchemaTables<S>[T] extends TableDef<
    ObjectShape,
    readonly IndexMeta[],
    "event",
    infer A,
    readonly string[]
  >
    ? Expand<InferInputShape<A>>
    : never;
