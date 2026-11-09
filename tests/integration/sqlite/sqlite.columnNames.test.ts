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

it('should map application names across SQLite queries, constraints and application renames', async () => {
  await withSqliteDatabase(schemas, async ({ db, connector, native }) => {
    // Node 22.5 does not enable foreign-key enforcement by default.
    native.exec('pragma foreign_keys = on')
    expect(native.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })

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
