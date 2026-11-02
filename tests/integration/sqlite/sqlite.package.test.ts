import { integer, number, pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import type { createDatabase, defineTable } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

it('should create a table and round-trip a row through the built package', async () => {
  // A variable specifier keeps typecheck independent of a prior build.
  const packageName = 'stratom'
  const library = (await import(packageName)) as {
    createDatabase: typeof createDatabase
    defineTable: typeof defineTable
  }

  const Records = library.defineTable(
    'package_records',
    { id: pipe(number(), integer()), label: string() },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase(
    [Records],
    async ({ db }) => {
      await db.migrate().execute()
      await db.insert(Records).values({ id: 1, label: 'package value' }).execute()

      expect(await db.from(Records).where({ id: 1 }).execute()).toEqual([
        { id: 1, label: 'package value' },
      ])
    },
    { library },
  )
})
