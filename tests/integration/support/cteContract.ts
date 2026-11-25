import { boolean, date, nullable, number, object, string } from 'valibot'
import { expect } from 'vitest'

import type { Db } from '@/index'
import { alias, defineTable, eq, exists, outer } from '@/index'

const Nodes = defineTable(
  'cte_nodes',
  {
    id: number(),
    parent: nullable(number()),
    label: string(),
    flag: boolean(),
    created: date(),
    json: object({ n: number() }),
  },
  { primaryKey: 'id' },
)

const tables = [Nodes] as const

async function assertCtes(db: Db): Promise<void> {
  await db.migrate().execute()
  const extra = { flag: true, created: new Date('2026-01-01T00:00:00Z'), json: { n: 1 } }
  await db
    .insert(Nodes)
    .values([
      { id: 1, parent: null, label: 'root', ...extra },
      { id: 2, parent: 1, label: 'child', ...extra },
      { id: 3, parent: 2, label: 'leaf', ...extra },
    ])
    .execute()

  const first = db.cte('first', db.from(Nodes).where(eq(Nodes.id, 1)))
  expect(
    await db
      .with(first)
      .from(first)
      .where(exists(db.from(Nodes).where(eq(Nodes.id, outer(first.id)))))
      .execute(),
  ).toEqual([{ id: 1, parent: null, label: 'root', ...extra }])

  const second = db.cte('second', db.from(first))
  const named = alias(second, 'renamed')
  expect(await db.with(second).from(named).execute()).toEqual([
    { id: 1, parent: null, label: 'root', ...extra },
  ])

  expect(
    await db
      .with(second)
      .from(Nodes)
      .where(exists(db.from(second)))
      .select([Nodes.id])
      .orderBy(Nodes.id)
      .execute(),
  ).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])

  await assertRecursiveCtes(db)
  await assertUnionModes(db)
  await assertOutputNames(db)

  await db.transaction(async (trx) => {
    const local = trx.cte(
      'local',
      trx.from(Nodes).select([Nodes.id]).where(eq(Nodes.id, 2)),
    )

    expect(await trx.with(local).from(local).execute()).toEqual([{ id: 2 }])
  })
}

async function assertRecursiveCtes(db: Db): Promise<void> {
  for (const union of ['all', 'distinct'] as const) {
    const tree = db.cte(
      'tree',
      db.from(Nodes).select([Nodes.id]).where(eq(Nodes.id, 1)),
      (self) =>
        db
          .from(Nodes)
          .innerJoin(self, (b) => b.eq(Nodes.parent, self.id))
          .select([Nodes.id]),
      { union },
    )

    expect(await db.with(tree).from(tree).orderBy(tree.id).execute()).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ])
  }

  const nullableTree = db.cte(
    'nullable_tree',
    db
      .from(Nodes)
      .select((b) => [b.as(Nodes.id, 'value')])
      .where(eq(Nodes.id, 1)),
    (self) =>
      db
        .from(Nodes)
        .innerJoin(self, (b) => b.eq(Nodes.id, self.value))
        .select((b) => [b.as(Nodes.parent, 'value')]),
  )

  expect(await db.with(nullableTree).from(nullableTree).execute()).toEqual([
    { value: 1 },
    { value: null },
  ])
}

async function assertUnionModes(db: Db): Promise<void> {
  const seed = db
    .from(Nodes)
    .select([Nodes.id])
    .where((b) => b.lt(Nodes.id, 3))

  for (const union of ['all', 'distinct'] as const) {
    const tree = db.cte(
      'overlapping_tree',
      seed,
      (self) =>
        db
          .from(Nodes)
          .innerJoin(self, (b) => b.eq(Nodes.parent, self.id))
          .select([Nodes.id]),
      { union },
    )

    expect(await db.with(tree).from(tree).orderBy(tree.id).execute()).toEqual(
      (union === 'all' ? [1, 2, 2, 3, 3] : [1, 2, 3]).map((id) => ({ id })),
    )
  }
}

async function assertOutputNames(db: Db): Promise<void> {
  const numericNames = db.cte(
    'numeric_names',
    db
      .from(Nodes)
      .select((b) => [b.as(Nodes.label, '2'), b.as(Nodes.flag, '1')])
      .where(eq(Nodes.id, 1)),
  )

  expect(
    await db
      .with(numericNames)
      .from(numericNames)
      .where(eq(numericNames['2'], 'root'))
      .execute(),
  ).toEqual([{ '1': true, '2': 'root' }])

  const name = 'column_name_that_exceeds_the_postgresql_sixty_three_byte_identifier_limit'

  const source = db
    .from(Nodes)
    .select((b) => [
      b.as(Nodes.id, name),
      b.as(Nodes.label, 'Label'),
      b.as(Nodes.parent, 'label'),
      b.as(Nodes.id, '*'),
      b.as(Nodes.id, 'constructor'),
    ])
    .where(eq(Nodes.id, 1))

  const cte = db.cte('quoted"name', source)
  const named = alias(cte, 'renamed')
  expect(await db.with(cte).from(named).execute()).toEqual([
    { [name]: 1, Label: 'root', label: null, '*': 1, constructor: 1 },
  ])

  const sameName = db.cte(
    'cte_nodes',
    db.from(Nodes).select([Nodes.id]).where(eq(Nodes.id, 1)),
  )

  expect(await db.with(sameName).from(sameName).execute()).toEqual([{ id: 1 }])
  const combined = db.cte(
    'combined',
    db
      .from(Nodes)
      .select([Nodes.id])
      .where(eq(Nodes.id, 1))
      .unionAll(db.from(Nodes).select([Nodes.id]).where(eq(Nodes.id, 2))),
  )

  expect(await db.with(combined).from(combined).orderBy(combined.id).execute()).toEqual([
    { id: 1 },
    { id: 2 },
  ])
}

export { tables, assertCtes }
