import { pipe, string } from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { column, defineTable } from '@/index'
import { MigrationError, SchemaError } from '@/utils/error'

import { waitForPostgres } from './postgres.setup'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

it('should keep invalid PostgreSQL ownership as SchemaError through execution', async () => {
  await withPostgresDatabase([], async ({ createDatabase }) => {
    const db = createDatabase([], {
      migrationOwnership: [
        { kind: 'relation', relation: { relation: 'missing' }, shape: 'complete' },
      ],
    })

    await expect(db.migrate().plan()).rejects.toBeInstanceOf(SchemaError)
    await expect(db.migrate().dryRun()).rejects.toBeInstanceOf(SchemaError)
    await expect(db.migrate().execute()).rejects.toBeInstanceOf(SchemaError)
  })
})

it('should report an unsafe PostgreSQL physical type as a planning error', async () => {
  const Invalid = defineTable(
    'invalid_type',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'text; drop table x' } })),
    },
    { primaryKey: 'id' },
  )

  await withPostgresDatabase([Invalid], async ({ db }) => {
    const error = await db
      .migrate()
      .plan()
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(MigrationError)

    expect(error).toMatchObject({
      stage: 'planning',
      outcome: 'unchanged',
      retryable: false,
    })

    expect((error as MigrationError).defect).toBeUndefined()
  })
})
