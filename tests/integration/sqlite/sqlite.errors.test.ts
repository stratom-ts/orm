import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import { column, createDatabase, defineTable } from '@/index'
import { MigrationError, SchemaError } from '@/utils/error'

it.each([
  ['NUL', 'has\0nul'],
  ['unpaired surrogate', 'has\ud800surrogate'],
])('rejects authored SQLite relation identifiers containing %s', async (_, name) => {
  const Invalid = defineTable(
    name,
    { id: pipe(string(), column({})) },
    { primaryKey: 'id' },
  )

  const db = createDatabase({
    connector: nodeSqliteConnector({ name: ':memory:' }),
    schemas: [Invalid],
  })

  try {
    await expect(db.migrate().plan()).rejects.toBeInstanceOf(SchemaError)
    await expect(db.migrate().dryRun()).rejects.toBeInstanceOf(SchemaError)
    await expect(db.migrate().execute()).rejects.toBeInstanceOf(SchemaError)
  } finally {
    await db.close()
  }
})

it('keeps invalid SQLite ownership as SchemaError through plan, dry run, and execute', async () => {
  const db = createDatabase({
    connector: nodeSqliteConnector({ name: ':memory:' }),
    schemas: [],
    migrationOwnership: [
      { kind: 'relation', relation: { relation: 'missing' }, shape: 'complete' },
    ],
  })

  try {
    await expect(db.migrate().plan()).rejects.toBeInstanceOf(SchemaError)
    await expect(db.migrate().dryRun()).rejects.toBeInstanceOf(SchemaError)
    await expect(db.migrate().execute()).rejects.toBeInstanceOf(SchemaError)
  } finally {
    await db.close()
  }
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

  const db = createDatabase({
    connector: nodeSqliteConnector({ name: ':memory:' }),
    schemas: [First, Second],
  })

  try {
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
  } finally {
    await db.close()
  }
})
