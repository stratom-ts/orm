import { date, number, pipe, string } from 'valibot'
import { expect } from 'vitest'

import { column, defineTable } from '@/index'
import type { Db, TransactionOptions } from '@/index'

export const Projects = defineTable(
  'edit_projects',
  { id: number(), workspace: string() },
  { primaryKey: 'id' },
)
export const Issues = defineTable(
  'edit_issues',
  {
    id: number(),
    workspace: string(),
    project: number(),
    title: pipe(string(), column({ name: 'issue_title' })),
    updatedAt: date(),
  },
  { primaryKey: 'id' },
)
export const History = defineTable(
  'edit_history',
  {
    before: string(),
    after: string(),
    issue: number(),
  },
  { primaryKey: ['issue', 'after'] },
)
export const tables = [Projects, Issues, History] as const
export const initialDate = new Date('2026-01-01T00:00:00Z')

export async function seed(db: Db) {
  await db.migrate().execute()
  await db.insert(Projects).values({ id: 1, workspace: 'a' }).execute()

  await db
    .insert(Issues)
    .values({ id: 1, workspace: 'a', project: 1, title: 'A', updatedAt: initialDate })
    .execute()
}

/** Reads authorization and the stored predecessor under the same transaction intent. */
export async function edit(
  db: Db,
  intent: TransactionOptions,
  title: string,
  options: {
    workspace?: string
    id?: number
    fail?: boolean
    afterRead?: () => Promise<void>
  } = {},
) {
  return db.transaction(async (tx) => {
    const workspace = options.workspace ?? 'a'
    await tx.from(Projects).where({ id: 1, workspace }).executeTakeFirstOrThrow()
    const before = await tx
      .from(Issues)
      .where({ id: options.id ?? 1, project: 1, workspace })
      .executeTakeFirst()

    if (!before) return undefined

    await options.afterRead?.()

    if (before.title === title) return before

    const after = await tx
      .update(Issues)
      .set({ title, updatedAt: new Date('2026-02-01T00:00:00Z') })
      .where({ id: before.id, project: 1, workspace })
      .executeTakeFirstOrThrow()

    const entry = { before: before.title, after: title, issue: before.id }
    await tx.insert(History).values(entry).execute()

    if (options.fail) await tx.insert(History).values(entry).execute()

    return after
  }, intent)
}

/** Checks rollback and missing/scoped rows through a second native client. */
export async function assertWorkflow(db: Db, observer: Db, intent: TransactionOptions) {
  await seed(db)

  expect(await edit(db, intent, 'A')).toMatchObject({
    title: 'A',
    updatedAt: initialDate,
  })

  expect(await observer.from(History).execute()).toEqual([])
  expect(await edit(db, intent, 'B', { id: 999 })).toBeUndefined()
  await expect(edit(db, intent, 'B', { workspace: 'b' })).rejects.toThrow(/No rows/)

  expect(
    await db.transaction(
      (tx) =>
        tx.from(Issues).where({ id: 1, workspace: 'b', project: 1 }).executeTakeFirst(),
      intent,
    ),
  ).toBeUndefined()

  await expect(edit(db, intent, 'B', { fail: true })).rejects.toMatchObject({
    kind: 'uniqueViolation',
  })

  expect(await observer.from(Issues).executeTakeFirstOrThrow()).toMatchObject({
    title: 'A',
    updatedAt: initialDate,
  })

  expect(await observer.from(History).execute()).toEqual([])
  expect(await edit(observer, intent, 'B')).toMatchObject({ title: 'B' })
  expect(await edit(db, intent, 'C')).toMatchObject({ title: 'C' })

  expect(await observer.from(History).orderBy(History.after).execute()).toEqual([
    { before: 'A', after: 'B', issue: 1 },
    { before: 'B', after: 'C', issue: 1 },
  ])
}

/** Unwinds the test immediately if an edit settles before its read barrier. */
export async function waitForRead(
  read: Promise<void>,
  operation: Promise<unknown>,
  name: string,
): Promise<void> {
  await Promise.race([
    read,
    operation.then(() => {
      throw new Error(`${name} finished before the read barrier`)
    }),
  ])
}
