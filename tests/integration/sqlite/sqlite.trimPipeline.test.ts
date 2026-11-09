import { expect, it } from 'vitest'

import { TrimmedIssues, assertTrimmedTitleWrites } from '../support/trimPipelineContract'

import { withSqliteDatabase } from './sqliteIntegration'

it('should infer string storage and normalize trimmed titles in SQLite', async () => {
  await withSqliteDatabase([TrimmedIssues] as const, async ({ db, native }) => {
    await assertTrimmedTitleWrites(db)

    expect(
      native.prepare('select title from trimmed_issues where id = ?').get('first'),
    ).toEqual({ title: 'Updated title' })
  })
})
