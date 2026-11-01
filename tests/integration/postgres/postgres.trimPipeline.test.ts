import { beforeAll, expect, it } from 'vitest'

import { TrimmedIssues, assertTrimmedTitleWrites } from '../support/trimPipelineContract'

import { waitForPostgres } from './postgres.setup'
import { quoteIdentifier, withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

it('infers string storage and normalizes trimmed titles in PostgreSQL', async () => {
  await withPostgresDatabase([TrimmedIssues] as const, async ({ db, admin, schema }) => {
    await assertTrimmedTitleWrites(db)

    expect(
      (
        await admin.query(
          `select title from ${quoteIdentifier(schema)}.trimmed_issues where id = $1`,
          ['first'],
        )
      ).rows,
    ).toEqual([{ title: 'Updated title' }])
  })
})
