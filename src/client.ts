import type { DialectAdapter } from '@/dialects'
import { postgresAdapter } from '@/dialects'
import type { TableSchema } from '@/helpers'
import type { InferDBFromArray } from '@/types/infer'
import type { Dialect } from 'kysely'
import { Kysely } from 'kysely'
import { runMigrations } from './migrator'

/** Kysely instance with a schema-driven `migrate` helper. */
export type Db<T> = Kysely<T> & {
  migrate(adapter?: DialectAdapter): Promise<void>
}

/**
 * Creates a typed Kysely client from table schemas and a dialect.
 *
 * @param config - Dialect and table schemas used for typing and migrations
 * @returns Kysely instance with `migrate()` bound to the given schemas
 *
 * @example
 * ```ts
 * const db = createDb({
 *   dialect: new PostgresDialect({ pool }),
 *   schemas: [UserSchema, PostSchema] as const,
 * })
 * await db.migrate()
 * ```
 */
export function createDb<
  const TSchemas extends readonly TableSchema<string>[],
>(config: {
  dialect: Dialect
  schemas: TSchemas
}): Db<InferDBFromArray<TSchemas>> {
  const db = new Kysely<InferDBFromArray<TSchemas>>({ dialect: config.dialect })

  const migrate = async (adapter: DialectAdapter = postgresAdapter) => {
    await runMigrations<InferDBFromArray<TSchemas>>(
      db as Kysely<InferDBFromArray<TSchemas>>,
      config.schemas as unknown as TableSchema[],
      adapter,
    )
  }

  return Object.assign(db, { migrate })
}
