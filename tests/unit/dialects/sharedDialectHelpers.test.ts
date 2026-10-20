import { pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import { registerDesiredSchema } from '@/ddl/desiredSchema'
import { postgresIdentity } from '@/dialects/postgres/identity'
import { compilePostgresOperationCommand } from '@/dialects/postgres/operations'
import { postgresSchema } from '@/dialects/postgres/schema'
import { sqliteIdentity } from '@/dialects/sqlite/identity'
import { compileSqliteOperationCommand } from '@/dialects/sqlite/operations'
import { sqliteSchema } from '@/dialects/sqlite/schema'
import type { AuthoredDesiredSchema, DialectSchema } from '@/dialects/types'
import { column, defineTable, reference } from '@/index'
import type { CanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'

type Member = Readonly<{
  name: string
  schema: DialectSchema
  identities(): CanonicalRelationIdentityModule
}>

const members: readonly Member[] = [
  {
    name: 'PostgreSQL',
    schema: postgresSchema,
    identities: () =>
      postgresIdentity.create({
        context: {
          writableDefault: [
            { role: 'database', spelling: 'test' },
            { role: 'schema', spelling: 'public' },
          ],
        },
      }),
  },
  {
    name: 'SQLite',
    schema: sqliteSchema,
    identities: () =>
      sqliteIdentity.create({
        context: { writableDefault: [{ role: 'database', spelling: 'main' }] },
      }),
  },
]

/** Creates a string schema with valid physical storage for both production members. */
function physicalString() {
  return pipe(string(), column({ physicalType: { postgresql: 'uuid', sqlite: 'TEXT' } }))
}

/** Creates a registered parent-child reference graph. */
function referenceFixture(member: Member) {
  const Parent = defineTable('parents', { id: physicalString() }, { primaryKey: 'id' })
  const Child = defineTable(
    'children',
    { id: physicalString(), parentId: reference(Parent, 'id') },
    { primaryKey: 'id' },
  )

  return {
    Parent,
    graph: registerDesiredSchema([Child, Parent], member.identities()),
  }
}

/** Creates a graph whose reference-only types form a stable two-table cycle. */
function cycleGraph(member: Member): AuthoredDesiredSchema {
  const InitialB = defineTable('cycle_b', { id: physicalString() }, { primaryKey: 'id' })
  const CycleA = defineTable(
    'cycle_a',
    { id: reference(InitialB, 'id') },
    { primaryKey: 'id' },
  )

  const CycleB = defineTable(
    'cycle_b',
    { id: reference(CycleA, 'id') },
    { primaryKey: 'id' },
  )

  return registerDesiredSchema([CycleB, CycleA], member.identities())
}

/** Creates equal comparison keys so authored spelling decides validation order. */
function tiedColumnGraph(member: Member): AuthoredDesiredSchema {
  const unsupported = () =>
    pipe(
      string(),
      column({
        physicalType: { postgresql: 'text', sqlite: 'TEXT' },
        comment: 'unsupported',
      }),
    )

  const Records = defineTable(
    'records',
    { Zulu: unsupported(), Alpha: unsupported() },
    { primaryKey: 'Alpha' },
  )

  const registered = registerDesiredSchema([Records], member.identities())

  return {
    tables: registered.tables.map((table) => ({
      ...table,
      columns: table.columns.map((item) => ({
        ...item,
        identifier: { ...item.identifier, comparisonKey: 'same' },
      })),
    })),
  }
}

it.each(members)(
  'should resolve reference types and build one immutable result shape for $name',
  (member) => {
    const lowered = member.schema.lowerDesiredSchema(referenceFixture(member).graph)
    const child = lowered.tables.find(
      (table) => table.identity.relation.spelling === 'children',
    )!

    expect(
      child.columns.find((value) => value.identifier.spelling === 'parentId'),
    ).toMatchObject({ dataType: member.name === 'PostgreSQL' ? 'uuid' : 'TEXT' })

    expect(
      [
        lowered,
        lowered.tables,
        child,
        child.columns,
        child.primaryKey,
        ...child.columns,
      ].every(Object.isFrozen),
    ).toBe(true)
  },
)

it.each(members)('should preserve missing-target diagnostics for $name', (member) => {
  const { Parent, graph } = referenceFixture(member)

  expect(() =>
    member.schema.lowerDesiredSchema({
      tables: graph.tables.filter((table) => table.handle !== Parent),
    }),
  ).toThrow(
    /Reference \[.*relation:"children", column:"parentId"\] targets unregistered relation \[.*relation:"parents"\]/,
  )
})

it.each(members)(
  'should preserve reference-only cycle diagnostics for $name',
  (member) => {
    expect(() => member.schema.lowerDesiredSchema(cycleGraph(member))).toThrow(
      /Cannot resolve reference-only physical type cycle at \[.*relation:"cycle_a", column:"id"\]/,
    )
  },
)

it.each(members)(
  'should order equal canonical column keys by authored spelling for $name',
  (member) => {
    expect(() => member.schema.lowerDesiredSchema(tiedColumnGraph(member))).toThrow(
      new RegExp(
        `${member.name} migration lowering does not support comments on .*column:"Alpha"`,
        'i',
      ),
    )
  },
)

it('should use one replaceable lifecycle command compiler for both production members', () => {
  const command = { kind: 'rollbackToSavepoint' as const, id: 7 }
  const expected = { sql: 'rollback to savepoint sp_7', params: [] }

  expect(compilePostgresOperationCommand(command)).toEqual(expected)
  expect(compileSqliteOperationCommand(command)).toEqual(expected)
})
