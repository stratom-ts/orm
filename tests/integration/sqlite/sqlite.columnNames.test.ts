import { expect, it } from 'vitest'

import { createDatabase } from '@/index'

import {
  CanonicalA,
  CanonicalB,
  PhysicalChanged,
  assertApplicationRename,
  assertPhysicalChanges,
  exerciseColumnNames,
  renamedSchemas,
  schemas,
} from '../support/columnNamesContract'

import { withSqliteDatabase } from './sqliteIntegration'

it('maps application names across SQLite queries, constraints and application renames', async () => {
  await withSqliteDatabase(schemas, async ({ db, connector }) => {
    await exerciseColumnNames(db)
    const renamed = createDatabase({ connector, schemas: renamedSchemas })
    const canonicalA = createDatabase({ connector, schemas: [CanonicalA] })
    const canonicalB = createDatabase({ connector, schemas: [CanonicalB] })
    const complete = createDatabase({ connector, schemas: [PhysicalChanged] })
    const additive = createDatabase({
      connector,
      schemas: [PhysicalChanged],
      migrationOwnership: [
        { kind: 'relation', relation: PhysicalChanged, shape: 'additive' },
      ],
    })

    try {
      await assertApplicationRename(renamed)
      expect(await canonicalA.migrate().plan()).toEqual(await canonicalB.migrate().plan())
      await assertPhysicalChanges(complete, additive, db)
    } finally {
      await Promise.all(
        [renamed, canonicalA, canonicalB, complete, additive].map((client) =>
          client.close(),
        ),
      )
    }
  })
})
