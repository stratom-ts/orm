import { integer, nullable, number, pipe, string } from 'valibot'
import { expect } from 'vitest'

import { add, column, defineTable } from '@/index'
import type { Db } from '@/index'

export const Projects = defineTable(
  'counter_projects',
  {
    id: pipe(number(), integer()),
    workspace: string(),
    nextIssueNumber: pipe(number(), integer()),
    other: pipe(number(), integer()),
    fraction: pipe(number(), column({ name: 'fraction_value' })),
    optional: nullable(number()),
  },
  { primaryKey: 'id' },
)
export const Issues = defineTable(
  'counter_issues',
  {
    number: pipe(number(), integer()),
    project: pipe(number(), integer()),
  },
  { primaryKey: ['project', 'number'] },
)
export const History = defineTable(
  'counter_history',
  {
    number: pipe(number(), integer()),
    project: pipe(number(), integer()),
    event: string(),
  },
  { primaryKey: ['project', 'number', 'event'] },
)
export const tables = [Projects, Issues, History] as const

export async function seed(db: Db<typeof tables>) {
  await db.migrate().execute()

  await db
    .insert(Projects)
    .values([
      {
        id: 1,
        workspace: 'a',
        nextIssueNumber: 1,
        other: 10,
        fraction: 1.5,
        optional: null,
      },
      {
        id: 2,
        workspace: 'b',
        nextIssueNumber: 1,
        other: 10,
        fraction: 1.5,
        optional: null,
      },
    ])
    .execute()
}

export async function allocate(db: Db<typeof tables>, fail = false) {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(Projects)
      .set({ nextIssueNumber: add(Projects.nextIssueNumber, 1) })
      .where({ id: 1, workspace: 'a' })
      .returning([Projects.nextIssueNumber])
      .executeTakeFirstOrThrow()

    const number = updated.nextIssueNumber - 1
    await tx.insert(Issues).values({ project: 1, number }).execute()
    await tx.insert(History).values({ project: 1, number, event: 'created' }).execute()

    if (fail)
      await tx.insert(History).values({ project: 1, number, event: 'created' }).execute()

    return number
  })
}

/** Checks database arithmetic, including physical names and numeric promotion. */
async function assertNumericAssignments(db: Db<typeof tables>) {
  const changed = await db
    .update(Projects)
    .set({
      fraction: add(Projects.fraction, 0.25),
      optional: add(Projects.optional, 1),
      other: add(Projects.nextIssueNumber, -1),
    })
    .where({ id: 1, workspace: 'a' })
    .executeTakeFirstOrThrow()

  expect(changed).toMatchObject({ fraction: 1.75, optional: null, other: 0 })

  expect(
    await db
      .update(Projects)
      .set({ fraction: add(Projects.other, 0.5) })
      .where({ id: 1, workspace: 'a' })
      .executeTakeFirstOrThrow(),
  ).toMatchObject({ fraction: 0.5 })

  expect(
    await db
      .update(Projects)
      .set({ fraction: add(Projects.other, 4294967296) })
      .where({ id: 1, workspace: 'a' })
      .executeTakeFirstOrThrow(),
  ).toMatchObject({ fraction: 4294967296 })
}

export async function basicAndRollback(
  db: Db<typeof tables>,
  observer: Db<typeof tables>,
) {
  await seed(db)
  await assertNumericAssignments(db)

  expect(
    await db
      .update(Projects)
      .set({ nextIssueNumber: add(Projects.nextIssueNumber, 1) })
      .where({ id: 1, workspace: 'missing' })
      .execute(),
  ).toEqual([])

  await expect(allocate(db, true)).rejects.toThrow(
    /Failed to insert into.*counter_history/,
  )

  expect(
    await observer.from(Projects).where({ id: 1 }).executeTakeFirstOrThrow(),
  ).toMatchObject({ nextIssueNumber: 1 })

  expect(await observer.from(Issues).execute()).toEqual([])
  expect(await observer.from(History).execute()).toEqual([])
  expect(await allocate(db)).toBe(1)

  expect(
    await observer.from(Projects).where({ id: 1 }).executeTakeFirstOrThrow(),
  ).toMatchObject({ nextIssueNumber: 2 })

  expect(
    await observer.from(Projects).where({ id: 2 }).executeTakeFirstOrThrow(),
  ).toMatchObject({ nextIssueNumber: 1 })

  expect(await observer.from(Issues).execute()).toEqual([{ project: 1, number: 1 }])

  expect(await observer.from(History).execute()).toEqual([
    { project: 1, number: 1, event: 'created' },
  ])
}
