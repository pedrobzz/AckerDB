/**
 * The `admin` object: one place where administration is configured.
 *
 * Everything administrative is configured here rather than beside the
 * subsystem it happens to touch, because an operator reasons about
 * administration as one thing — what the surface reports, how long it keeps
 * what it observes, whether an agent may reach it — and a setting per
 * subsystem would scatter that decision across four option bags.
 *
 * Its one field today names the application. Nothing else in the framework
 * does: the manifest describes a schema, the configuration describes paths and
 * ports, and the protocol describes authentication. An operator looking at a
 * connected application needs to know *which* application, so the Admin API
 * needs a name to answer with, and this is where that name is decided.
 */

/** How the administration surface names this application to an operator. */
export interface AdminApplicationOptions {
  /** Defaults to the application package's name, then to its directory. */
  readonly name?: string;
  /** Defaults to the application package's version. */
  readonly version?: string;
}

export interface AdminOptions {
  readonly application?: AdminApplicationOptions;
}

export interface NormalizedAdminApplication {
  readonly name: string;
  readonly version: string;
}

/** The resolved object every administrative declaration reads. */
export interface NormalizedAdminOptions {
  readonly application: NormalizedAdminApplication;
}

/**
 * The longest name or version the surface will carry. A header renders it and
 * an operator reads it; anything longer is a payload, not an identity.
 */
export const MAX_ADMIN_APPLICATION_BYTES = 128;

const utf8 = new TextEncoder();

/**
 * What an embedder that names nothing is called. The CLI always names the
 * application from its own package, so this is reached only by a host that
 * assembles a Runtime by hand and declines to say what it is running.
 */
const UNNAMED_APPLICATION: NormalizedAdminApplication = Object.freeze({
  name: "application",
  version: "0.0.0",
});

function adminName(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    utf8.encode(value).byteLength > MAX_ADMIN_APPLICATION_BYTES
  ) {
    throw new TypeError(
      `${where} must be a trimmed non-empty string of at most ${MAX_ADMIN_APPLICATION_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

function plainObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * The one interpreter of the `admin` object. It is re-read rather than
 * trusted, exactly as a declaration's own fields are: the Registry composes
 * the framework's declarations from it, and an untyped host handing it a
 * number would otherwise put that number in an operator's header.
 */
export function normalizeAdminOptions(
  value: unknown = {},
  where = "admin",
): NormalizedAdminOptions {
  const options = plainObject(value, where);
  if (options.application === undefined) {
    return Object.freeze({ application: UNNAMED_APPLICATION });
  }
  const application = plainObject(options.application, `${where}.application`);
  return Object.freeze({
    application: Object.freeze({
      name: application.name === undefined
        ? UNNAMED_APPLICATION.name
        : adminName(application.name, `${where}.application.name`),
      version: application.version === undefined
        ? UNNAMED_APPLICATION.version
        : adminName(application.version, `${where}.application.version`),
    }),
  });
}
