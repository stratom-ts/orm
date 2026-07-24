import type { DialectAdapter } from '@/dialects'
import { postgresAdapter } from '@/dialects'
import type { TableSchema } from '@/helpers'
import type { InferDBFromArray } from '@/types/infer'
import type { Dialect } from 'kysely'
import { Kysely } from 'kysely'
import { runMigrations } from './migrator'

export type Db<T> = Kysely<T> & {
  migrate(adapter?: DialectAdapter): Promise<void>
}

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
