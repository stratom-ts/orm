import { nullable, number, object, parse, pipe, string, title } from 'valibot'
import { expect, it, vi } from 'vitest'

import { lowerDesiredSchema, registerDesiredSchema } from '@/ddl/desiredSchema'
import { postgresDialect } from '@/dialects'
import { POSTGRES_IDENTITY_POLICY } from '@/dialects/postgres/identity'
import type { ReferenceTarget, TableHandle } from '@/index'
import {
  column,
  defineTable,
  getColumnMetadata,
  getReferenceMetadata,
  reference,
  table,
} from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { createValueMapper } from '@/query'

const identities = () =>
  createCanonicalRelationIdentityModule({
    policy: POSTGRES_IDENTITY_POLICY,
    context: {
      writableDefault: [
        { role: 'database', spelling: 'test' },
        { role: 'schema', spelling: 'public' },
      ],
    },
  })

function circular(reverse: boolean) {
  const makeA = () =>
    defineTable(
      'a',
      {
        id: pipe(
          string(),
          column({ name: 'a_key', physicalType: { postgresql: 'uuid' } }),
        ),
        bId: nullable(
          reference(string(), (): ReferenceTarget => B, 'id', { onDelete: 'set null' }),
        ),
      },
      { primaryKey: 'id' },
    )

  const makeB = () =>
    defineTable(
      'b',
      {
        id: pipe(
          string(),
          column({ name: 'b_key', physicalType: { postgresql: 'uuid' } }),
        ),
        aId: reference(string(), (): ReferenceTarget => A, 'id'),
      },
      { primaryKey: 'id' },
    )

  const [A, B] = reverse
    ? (() => {
        const b = makeB()
        return [makeA(), b] as const
      })()
    : ([makeA(), makeB()] as const)

  return [A, B] as const
}

it.each([false, true])(
  'lowers mutually circular declarations in either order (reverse=%s)',
  (reverse) => {
    const [A, B] = circular(reverse)
    const first = lowerDesiredSchema([A, B], identities(), postgresDialect.schema)
    const second = lowerDesiredSchema([B, A], identities(), postgresDialect.schema)
    expect(first).toEqual(second)

    expect(
      first.tables.map(
        (t) => t.columns.find((c) => c.reference)?.reference?.column.spelling,
      ),
    ).toEqual(['b_key', 'a_key'])

    expect(
      first.tables.flatMap((t) =>
        t.columns.filter((c) => c.reference).map((c) => c.dataType),
      ),
    ).toEqual(['uuid', 'uuid'])

    expect(
      createValueMapper(postgresDialect, undefined, [A, B]).columnTypes(A),
    ).toMatchObject({ bId: 'uuid' })
  },
)

it('does not evaluate callbacks during declaration, metadata inspection, or validation', () => {
  const target = vi.fn<() => ReferenceTarget>(() =>
    defineTable('unused', { id: string() }, { primaryKey: 'id' }),
  )

  const schema = reference(pipe(string(), column({ unique: true })), target, 'id')
  defineTable('source', { id: schema }, { primaryKey: 'id' })
  expect(parse(schema, 'valid')).toBe('valid')
  expect(() => parse(schema, 4)).toThrow(/Invalid type/)
  expect(getColumnMetadata(schema)).toMatchObject({ unique: true })
  expect(getReferenceMetadata(schema)).toBeUndefined()
  expect(target).not.toHaveBeenCalled()
})

it('evaluates a reused declaration once per graph and retains eager target intent', () => {
  const Target = defineTable('target', { id: string() }, { primaryKey: 'id' })
  const target = vi.fn<() => typeof Target>(() => Target)
  const lazy = reference(string(), target, 'id', { onUpdate: 'cascade' })
  const Source = defineTable(
    'source',
    { id: string(), one: lazy, two: nullable(lazy) },
    { primaryKey: 'id' },
  )

  const graph = registerDesiredSchema([Source, Target], identities())
  expect(target).toHaveBeenCalledTimes(1)
  const references = graph.tables[0].columns.filter((c) => c.reference)
  expect(references.map((c) => c.reference!.metadata)).toEqual([
    getReferenceMetadata(reference(Target, 'id', { onUpdate: 'cascade' })),
    getReferenceMetadata(reference(Target, 'id', { onUpdate: 'cascade' })),
  ])

  expect(Object.isFrozen(references[0].reference!.metadata.target.relation)).toBe(true)
  postgresDialect.schema.lowerDesiredSchema(graph)
  expect(target).toHaveBeenCalledTimes(1)
  registerDesiredSchema([Target, Source], identities())
  expect(target).toHaveBeenCalledTimes(2)
})

it('pins target identity across query mapping and later planning graphs', () => {
  const A = defineTable('a', { id: string() }, { primaryKey: 'id' })
  const B = defineTable('b', { id: string() }, { primaryKey: 'id' })
  let target: TableHandle = A
  const Source = defineTable(
    'source',
    { id: string(), target: reference(string(), () => target, 'id') },
    { primaryKey: 'id' },
  )

  createValueMapper(postgresDialect, undefined, [A, B, Source])
  const graph = registerDesiredSchema([A, B, Source], identities())
  target = B

  expect(graph.tables[2].columns[1].reference!.targetRelation.relation.spelling).toBe('a')

  expect(() =>
    lowerDesiredSchema([A, B, Source], identities(), postgresDialect.schema),
  ).toThrow(/identity changed/)
})

it('accepts a deferred raw schema with its registered column', () => {
  const raw = pipe(
    object({ id: string() }),
    title('target'),
    table({ name: 'target', primaryKey: 'id' }),
  )

  const Target = defineTable('target', raw.entries, { primaryKey: 'id' })
  const Source = defineTable(
    'source',
    { id: string(), target: reference(string(), () => raw, 'id') },
    { primaryKey: 'id' },
  )

  expect(
    registerDesiredSchema([Source, Target], identities()).tables[0].columns[1].reference!
      .metadata.target,
  ).toEqual({ relation: { relation: 'target' }, column: 'id' })
})

it('rejects missing, ambiguous and incompatible registrations deterministically', () => {
  const Target = defineTable('target', { id: string() }, { primaryKey: 'id' })
  const Duplicate = defineTable('target', { id: string() }, { primaryKey: 'id' })
  const source = (schema: ReturnType<typeof string> | ReturnType<typeof number>) =>
    defineTable(
      'source',
      {
        id: string(),
        target: reference(schema, (): ReferenceTarget => Target, 'id'),
      },
      { primaryKey: 'id' },
    )

  const Source = source(string())
  expect(() =>
    lowerDesiredSchema([Source], identities(), postgresDialect.schema),
  ).toThrow(/unregistered/)

  for (const handles of [
    [Source, Target, Duplicate],
    [Duplicate, Target, Source],
  ])
    expect(() =>
      lowerDesiredSchema(handles, identities(), postgresDialect.schema),
    ).toThrow(/ambiguous/)

  expect(() =>
    lowerDesiredSchema([source(number()), Target], identities(), postgresDialect.schema),
  ).toThrow(/incompatible/)
})

it('rejects absent callbacks, missing keys and different same-identity declarations during graph lowering', () => {
  const Target = defineTable('target', { id: string() }, { primaryKey: 'id' })
  let selected: TableHandle | undefined
  const Source = defineTable(
    'source',
    { id: string(), target: reference(string(), () => selected as TableHandle, 'id') },
    { primaryKey: 'id' },
  )

  expect(() =>
    lowerDesiredSchema([Source, Target], identities(), postgresDialect.schema),
  ).toThrow(/target is missing/)

  selected = defineTable('target', { other: string() }, { primaryKey: 'other' })

  expect(() =>
    lowerDesiredSchema([Source, Target], identities(), postgresDialect.schema),
  ).toThrow(/missing application column/)

  selected = defineTable('target', { id: string() }, { primaryKey: 'id' })

  expect(() =>
    lowerDesiredSchema([Source, Target], identities(), postgresDialect.schema),
  ).toThrow(/differs from the registered/)
})

it('preserves callback defects by identity', () => {
  const defect = new Error('callback defect')
  const Source = defineTable(
    'source',
    {
      id: reference(
        string(),
        (): ReferenceTarget => {
          throw defect
        },
        'id',
      ),
    },
    { primaryKey: 'id' },
  )

  expect(() =>
    lowerDesiredSchema([Source], identities(), postgresDialect.schema),
  ).toThrow(defect)

  const failure = (() => {
    try {
      lowerDesiredSchema([Source], identities(), postgresDialect.schema)
    } catch (cause) {
      return cause
    }
  })()

  expect(failure).toBe(defect)
})

it('checks local referential actions and preserves local defaults without early resolution', () => {
  const Target = defineTable('target', { id: string() }, { primaryKey: 'id' })
  const target = vi.fn<() => typeof Target>(() => Target)
  expect(() =>
    defineTable(
      'invalid_null',
      {
        id: reference(string(), target, 'id', { onDelete: 'set null' }),
      },
      { primaryKey: 'id' },
    ),
  ).toThrow(/SET NULL/)

  expect(() =>
    defineTable(
      'invalid_default',
      {
        id: reference(string(), target, 'id', { onDelete: 'set default' }),
      },
      { primaryKey: 'id' },
    ),
  ).toThrow(/SET DEFAULT/)

  const Source = defineTable(
    'source',
    {
      id: reference(
        pipe(
          string(),
          column({ databaseDefault: { kind: 'literal', value: 'fallback' } }),
        ),
        target,
        'id',
        { onDelete: 'set default' },
      ),
    },
    { primaryKey: 'id' },
  )

  expect(target).not.toHaveBeenCalled()
  const graph = lowerDesiredSchema([Source, Target], identities(), postgresDialect.schema)
  expect(graph.tables[0].columns[0]).toMatchObject({
    databaseDefault: { sql: "'fallback'" },
    reference: { onDelete: 'set default' },
  })
})

it('uses the nearest reference when eager and lazy declarations are nested', () => {
  const Target = defineTable('target', { id: string() }, { primaryKey: 'id' })
  const Other = defineTable('other', { id: string() }, { primaryKey: 'id' })
  const Intermediate = defineTable(
    'intermediate',
    {
      id: reference(string(), () => Target, 'id'),
    },
    { primaryKey: 'id' },
  )

  const Source = defineTable(
    'source',
    {
      id: reference(Intermediate, 'id'),
      other: reference(reference(Target, 'id'), () => Other, 'id'),
    },
    { primaryKey: 'id' },
  )

  const graph = registerDesiredSchema([Source, Intermediate, Target, Other], identities())
  const source = graph.tables.find((t) => t.identity.relation.spelling === 'source')!
  expect(
    source.columns.map((c) => c.reference!.targetRelation.relation.spelling),
  ).toEqual(['intermediate', 'other'])
})
