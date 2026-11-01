import { maxLength, minLength, nullable, optional, pipe, string, trim } from 'valibot'
import { expect } from 'vitest'

import type { Db } from '@/index'
import { defineTable } from '@/index'
import { ValidationError } from '@/utils/error'

const title = pipe(string(), trim(), minLength(1), maxLength(200))

export const TrimmedIssues = defineTable(
  'trimmed_issues',
  {
    id: string(),
    title,
    nullableTitle: nullable(title),
    defaultTitle: optional(title, '  Default title  '),
  },
  { primaryKey: 'id' },
)

/** Exercises the consumer title pipeline through each native dialect's public API. */
export async function assertTrimmedTitleWrites(db: Db<readonly [typeof TrimmedIssues]>) {
  await db.migrate().execute()
  const row = {
    id: 'first',
    title: 'First issue',
    nullableTitle: null,
    defaultTitle: 'Default title',
  }

  expect(
    await db
      .insert(TrimmedIssues)
      .values({ id: 'first', title: '  First issue  ', nullableTitle: null })
      .execute(),
  ).toEqual([row])

  expect(await db.from(TrimmedIssues).where({ id: 'first' }).execute()).toEqual([row])

  const boundary = {
    id: 'boundary',
    title: 'x'.repeat(200),
    nullableTitle: 'Nullable title',
    defaultTitle: 'Explicit default',
  }

  expect(
    await db
      .insert(TrimmedIssues)
      .values({
        ...boundary,
        title: `  ${boundary.title}  `,
        nullableTitle: '  Nullable title  ',
        defaultTitle: '  Explicit default  ',
      })
      .execute(),
  ).toEqual([boundary])

  await assertRejectedTitleWrites(db)
  expect(await db.from(TrimmedIssues).where({ id: 'first' }).execute()).toEqual([row])

  expect(
    await db
      .update(TrimmedIssues)
      .set({ title: '  Updated title  ' })
      .where({ id: 'first' })
      .execute(),
  ).toEqual([{ ...row, title: 'Updated title' }])

  expect(await db.from(TrimmedIssues).where({ id: 'first' }).execute()).toEqual([
    { ...row, title: 'Updated title' },
  ])
}

/** Confirms invalid inserts and updates do not persist title changes. */
async function assertRejectedTitleWrites(db: Db<readonly [typeof TrimmedIssues]>) {
  for (const invalid of ['   ', 'x'.repeat(201)]) {
    await expect(async () =>
      db
        .insert(TrimmedIssues)
        .values({ id: 'invalid', title: invalid, nullableTitle: null })
        .execute(),
    ).rejects.toThrow(ValidationError)

    await expect(async () =>
      db.update(TrimmedIssues).set({ title: invalid }).where({ id: 'first' }).execute(),
    ).rejects.toThrow(ValidationError)
  }

  expect(await db.from(TrimmedIssues).where({ id: 'invalid' }).execute()).toEqual([])
}
