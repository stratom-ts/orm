import { pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import { column, defineTable } from '@/index'
import { MigrationError, SchemaError } from '@/utils/error'

import { withSqliteDatabase } from './sqliteIntegration'

it.each([
  ['NUL', 'has\0nul'],
  ['unpaired surrogate', 'has\ud800surrogate'],
])('rejects authored SQLite relation identifiers containing %s', async (_, name) => {
  const Invalid = defineTable(
    name,
    { id: pipe(string(), column({})) },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Invalid], async ({ db }) => {
    await expect(db.migrate().plan()).rejects.toBeInstanceOf(SchemaError)
    await expect(db.migrate().dryRun()).rejects.toBeInstanceOf(SchemaError)
    await expect(db.migrate().execute()).rejects.toBeInstanceOf(SchemaError)
  })
})

it('keeps invalid SQLite ownership as SchemaError through plan, dry run, and execute', async () => {
  await withSqliteDatabase(
    [],
    async ({ db }) => {
      await expect(db.migrate().plan()).rejects.toBeInstanceOf(SchemaError)
      await expect(db.migrate().dryRun()).rejects.toBeInstanceOf(SchemaError)
      await expect(db.migrate().execute()).rejects.toBeInstanceOf(SchemaError)
    },
    {
      migrationOwnership: [
        { kind: 'relation', relation: { relation: 'missing' }, shape: 'complete' },
      ],
    },
  )
})

it('reports colliding SQLite index names as a planning failure', async () => {
  const First = defineTable(
    'first',
    { id: pipe(string(), column({})) },
    { primaryKey: 'id', indexes: [{ name: 'shared_idx', columns: ['id'] }] },
  )

  const Second = defineTable(
    'second',
    { id: pipe(string(), column({})) },
    { primaryKey: 'id', indexes: [{ name: 'shared_idx', columns: ['id'] }] },
  )

  await withSqliteDatabase([First, Second], async ({ db }) => {
    const error = await db
      .migrate()
      .plan()
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(MigrationError)

    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'planning',
      outcome: 'unchanged',
    })

    expect((error as MigrationError).defect).toBeUndefined()
  })
})
