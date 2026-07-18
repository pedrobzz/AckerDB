import { InvalidToolInputError, type ToolCallRepairFunction, type ToolSet } from "ai";

/**
 * DeepSeek's function calling does not honor `anyOf` member types and tends to
 * stringify every scalar argument (`{"limit":"50"}`, `{"activeOnly":"true"}`),
 * which dbzz's strict validators rightly reject. This repair — the AI SDK's
 * designed recovery seam for invalid tool input — coerces stringified scalars
 * back to the type the tool's own JSON schema declares, and nothing else. The
 * repaired call is re-validated by the SDK and dbzz, so genuinely invalid
 * input still fails; a repair that changes nothing rethrows the original
 * error by returning null.
 */
export function repairStringlyToolInput<TOOLS extends ToolSet>(): ToolCallRepairFunction<TOOLS> {
  return async ({ toolCall, inputSchema, error }) => {
    if (!InvalidToolInputError.isInstance(error)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.input) as unknown;
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const schema = await inputSchema({ toolName: toolCall.toolName });
    const properties =
      (schema as { properties?: Readonly<Record<string, unknown>> }).properties ?? {};
    let changed = false;
    const repaired: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const coerced = coerceScalar(value, properties[key]);
      if (coerced !== value) changed = true;
      repaired[key] = coerced;
    }
    if (!changed) return null;
    return { ...toolCall, input: JSON.stringify(repaired) };
  };
}

/** Every `type` a schema property admits, looking through `anyOf` unions. */
function typesOf(property: unknown, into = new Set<string>()): Set<string> {
  if (property === null || typeof property !== "object") return into;
  const { type, anyOf } = property as {
    readonly type?: string | readonly string[];
    readonly anyOf?: readonly unknown[];
  };
  if (typeof type === "string") into.add(type);
  if (Array.isArray(type)) for (const member of type) into.add(member as string);
  if (Array.isArray(anyOf)) for (const member of anyOf) typesOf(member, into);
  return into;
}

function coerceScalar(value: unknown, property: unknown): unknown {
  if (typeof value !== "string") return value;
  const types = typesOf(property);
  // A property that admits strings (or declares nothing) keeps its string.
  if (types.size === 0 || types.has("string")) return value;
  if (value === "null" && types.has("null")) return null;
  if ((value === "true" || value === "false") && types.has("boolean")) return value === "true";
  if ((types.has("number") || types.has("integer")) && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return value;
}
