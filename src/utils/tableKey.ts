/** Default Postgres schema when `table({ schema })` is omitted. */
export const DEFAULT_PG_SCHEMA = 'public'

/**
 * Canonical registry / migrate / catalog identity for a table.
 * Always includes a schema segment (`public` when omitted).
 */
export function tableKey(schema: string | undefined, name: string): string {
  return `${schema ?? DEFAULT_PG_SCHEMA}.${name}`
}

/**
 * Effective Postgres schema for a table handle or metadata.
 */
export function effectiveSchema(schema: string | undefined): string {
  return schema ?? DEFAULT_PG_SCHEMA
}
