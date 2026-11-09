import { expect, it } from 'vitest'

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

import { withPostgresDatabase } from './postgresIntegration'

it('should map application names across PostgreSQL queries, constraints and application renames', async () => {
  await withPostgresDatabase(schemas, async ({ db, createDatabase, schema }) => {
    await exerciseColumnNames(db, [schema])
    await assertApplicationRename(createDatabase(renamedSchemas))

    expect(await createDatabase([CanonicalA]).migrate().plan()).toEqual(
      await createDatabase([CanonicalB]).migrate().plan(),
    )

    await assertPhysicalChanges(
      createDatabase([PhysicalChanged]),
      createDatabase([PhysicalChanged], {
        migrationOwnership: [
          { kind: 'relation', relation: PhysicalChanged, shape: 'additive' },
        ],
      }),
      db,
    )
  })
})
