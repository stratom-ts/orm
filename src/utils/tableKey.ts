/** Default Postgres schema when `table({ schema })` is omitted. */
export const DEFAULT_PG_SCHEMA = 'public'

/**
 * Canonical registry / migrate / catalog identity for a table.
 * Always includes a schema segment (`public` when omitted).
 *
 * @example
 *   tableKey('public', 'users') // 'public.users'
 *   tableKey(undefined, 'users') // 'public.users'
 *
 * @param schema - Database schema name (defaults to `public`).
 * @param name - Table name.
 *
 * @returns Fully qualified table key in the form `schema.name`
 */
export function tableKey(schema: string | undefined, name: string): string {
  return `${schema ?? DEFAULT_PG_SCHEMA}.${name}`
}

/**
 * Effective Postgres schema for a schema name or `undefined`.
 *
 * @example
 *   effectiveSchema('my_schema') // 'my_schema'
 *   effectiveSchema(undefined) // 'public'
 *
 * @param schema - Schema name or `undefined` when omitted.
 *
 * @returns The provided schema, or `public` as the default
 */
export function effectiveSchema(schema: string | undefined): string {
  return schema ?? DEFAULT_PG_SCHEMA
}
