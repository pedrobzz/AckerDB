import type { ApiFromModules } from "@ackerdb/core";
import {
  channel,
  http,
  job,
  mutation,
  procedure,
  query,
  sseProcedure,
  v,
  type Definition,
} from "@ackerdb/server";

const queryDefinition = query({ args: {}, access: "public", handler: () => null });
const mutationDefinition = mutation({ args: {}, access: "public", handler: () => null });
const procedureDefinition = procedure({ args: {}, access: "public", handler: () => null });
const sseDefinition = sseProcedure({
  args: {},
  yields: v.string(),
  access: "public",
  handler: async function* () {},
});
const httpDefinition = http("/type-check", { GET: () => new Response(null) });
const jobDefinition = job({ args: {}, handler: () => null });
const channelDefinition = channel({
  args: {},
  clientEvents: {},
  serverEvents: {},
  access: "public",
  on: {},
});

[
  queryDefinition,
  mutationDefinition,
  procedureDefinition,
  sseDefinition,
  httpDefinition,
  jobDefinition,
  channelDefinition,
] satisfies readonly Definition[];

function exhaustivelyNarrow(definition: Definition): void {
  switch (definition.kind) {
    case "query":
      definition satisfies Extract<Definition, { readonly kind: "query" }>;
      return;
    case "mutation":
      definition satisfies Extract<Definition, { readonly kind: "mutation" }>;
      return;
    case "procedure":
      definition satisfies Extract<Definition, { readonly kind: "procedure" }>;
      return;
    case "sse":
      definition satisfies Extract<Definition, { readonly kind: "sse" }>;
      return;
    case "http":
      definition satisfies Extract<Definition, { readonly kind: "http" }>;
      return;
    case "job":
      definition satisfies Extract<Definition, { readonly kind: "job" }>;
      definition.mode satisfies "procedure" | "mutation";
      return;
    case "channel":
      definition satisfies Extract<Definition, { readonly kind: "channel" }>;
      return;
  }
  definition satisfies never;
}

exhaustivelyNarrow(queryDefinition);

type Api = ApiFromModules<{
  definitions: {
    query: typeof queryDefinition;
    http: typeof httpDefinition;
    job: typeof jobDefinition;
    channel: typeof channelDefinition;
    helper: { readonly label: string };
    plugin: { readonly kind: "plugin"; readonly version: number };
  };
}>;

declare const api: Api;
api.definitions.query.$ref satisfies string;
api.definitions.channel.$ref satisfies string;
// @ts-expect-error HTTP definitions are server-only by kind
api.definitions.http;
// @ts-expect-error Job definitions are server-only by kind
api.definitions.job;
// @ts-expect-error ordinary helper exports are not API paths
api.definitions.helper;
// @ts-expect-error unknown definition kinds are not API paths
api.definitions.plugin;
