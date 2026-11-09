import { nullable, number, pipe, string } from 'valibot'
import { expect, expectTypeOf, it, vi } from 'vitest'

import type { ColumnMetadata, InferSelect } from '@/index'
import {
  SchemaError,
  column,
  createDatabase,
  defineTable,
  postgresDialect,
  reference,
  sqliteDialect,
} from '@/index'
import { createTableBuilder, createValueMapper } from '@/query'
import { validateColumnNames } from '@/schemas/physicalColumn'

import { createMockPostgresConnector } from '../dialects/postgresNativeClientFixtures'

for (const dialect of [postgresDialect, sqliteDialect]) {
  it(`should reject invalid physical metadata before session acquisition for ${dialect.id}`, () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    for (const name of [undefined, null, 42, 1n, circular, '', 'bad\0name']) {
      const Records = defineTable(
        'invalid',
        { value: pipe(string(), column({ name } as unknown as ColumnMetadata)) },
        { primaryKey: 'value' },
      )

      expect(() => validateColumnNames([Records], dialect)).toThrow(SchemaError)
    }

    const connector = createMockPostgresConnector()
    const Bad = defineTable(
      'bad',
      { property: pipe(string(), column({ name: '' })) },
      { primaryKey: 'property' },
    )

    expect(() => createDatabase({ connector, schemas: [Bad] })).toThrow(/property/)
    expect(connector.prepared).toEqual([])
  })

  it(`should separate exact application lookup from physical comparison for ${dialect.id}`, () => {
    const Records = defineTable(
      'case_names',
      {
        fullName: pipe(string(), column({ name: 'value' })),
        FullName: pipe(string(), column({ name: 'VALUE' })),
      },
      { primaryKey: 'fullName' },
    )

    let failure: unknown
    try {
      validateColumnNames([Records], dialect)
    } catch (cause) {
      failure = cause
    }

    expect(failure instanceof SchemaError).toBe(dialect.id === 'sqlite')
    const distinct = defineTable(
      'distinct',
      {
        fullName: pipe(string(), column({ name: 'first' })),
        FullName: pipe(string(), column({ name: 'second' })),
      },
      { primaryKey: 'fullName' },
    )

    expect(() => validateColumnNames([distinct], dialect)).not.toThrow()
    const resolved = dialect.query.resolve([distinct])
    expect(resolved.findColumnMatches(distinct, 'FULLNAME')).toEqual([])
    expect(resolved.findColumnMatches(distinct, 'fullName')).toEqual(['fullName'])
    expect(resolved.findColumnMatches(distinct, 'first')).toEqual([])
    const duplicate = defineTable(
      'duplicate',
      {
        a: pipe(string(), column({ name: 'same' })),
        b: pipe(string(), column({ name: 'same' })),
      },
      { primaryKey: 'a' },
    )

    expect(() => validateColumnNames([duplicate], dialect)).toThrow(/same.*a.*b/)
    expect(() => reference(distinct, 'first' as 'fullName')).toThrow(/not defined/)
  })

  it(`should map explicit aliases from their selected source exactly once for ${dialect.id}`, async () => {
    const source = vi.fn<(value: unknown) => unknown>(
      (value) => `source:${String(value)}`,
    )

    const other = vi.fn<(value: unknown) => unknown>((value) => `other:${String(value)}`)
    const parameter = vi.fn<(value: unknown) => unknown>(
      (value) => `param:${String(value)}`,
    )

    const fallback = vi.fn<(type: string, value: unknown) => unknown>(
      (_type, value) => value,
    )

    const Records = defineTable(
      'mapped',
      {
        id: number(),
        label: nullable(
          pipe(
            string(),
            column({ name: 'stored_label', mapResult: source, mapParam: parameter }),
          ),
        ),
        other: pipe(string(), column({ mapResult: other })),
      },
      { primaryKey: 'id' },
    )

    expect(Records.label.column).toBe('label')
    expectTypeOf<InferSelect<typeof Records>['label']>().toEqualTypeOf<string | null>()
    const mapper = createValueMapper(dialect, { mapResultValue: fallback }, [Records])

    const executor = {
      execute: vi.fn<() => Promise<unknown[]>>(async () => [{ other: 'Ada' }]),
      run: vi.fn<() => Promise<number>>(async () => 1),
    }

    const selected = createTableBuilder({
      handle: Records,
      dialect,
      mapper,
      executor,
    })
      .select((b) => [b.as(Records.label, 'other')])
      .where(Records.label, 'eq', 'Ada')

    expect(await selected.execute()).toEqual([{ other: 'source:Ada' }])
    expect(source).toHaveBeenCalledExactlyOnceWith('Ada')
    expect(parameter).toHaveBeenCalledExactlyOnceWith('Ada')
    expect(other).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })

  it(`should restore long same-prefix outputs without an optional mapper for ${dialect.id}`, async () => {
    const key = '\u754c'.repeat(24)
    const first = `${key}1`
    const second = `${key}2`
    const Records = defineTable(
      'long_outputs',
      {
        [first]: pipe(string(), column({ name: 'first' })),
        [second]: pipe(string(), column({ name: 'second' })),
      },
      { primaryKey: first },
    )

    const executor = {
      execute: vi.fn<() => Promise<unknown[]>>(async () => [
        { __stratom_c0: 'A', __stratom_c1: 'B' },
      ]),
      run: vi.fn<() => Promise<number>>(async () => 1),
    }

    const from = createTableBuilder({ handle: Records, dialect, executor })
    expect(await from.execute()).toEqual([{ [first]: 'A', [second]: 'B' }])
    const compiled = from.compile()
    expect(compiled.sql).not.toContain(key)
    expect(Object.isFrozen(compiled.resultProjection)).toBe(true)
    expect(Object.isFrozen(compiled.resultProjection?.[0])).toBe(true)
  })

  it(`should restore unusual outputs without internal alias collisions for ${dialect.id}`, async () => {
    const property = 'bad\0property'
    const alias = '\ud800'
    const Records = defineTable(
      'unusual_outputs',
      {
        id: number(),
        [property]: pipe(string(), column({ name: 'stored' })),
        '': pipe(string(), column({ name: 'empty_property' })),
      },
      { primaryKey: 'id' },
    )

    const executor = {
      execute: vi.fn<() => Promise<unknown[]>>(async () => [
        { __stratom_c1: 'A', __stratom_c0: 1 },
      ]),
      run: vi.fn<() => Promise<number>>(async () => 0),
    }

    const from = createTableBuilder({ handle: Records, dialect, executor })
    const selected = from.select((b) => [
      b.as(Records.id, '__stratom_c0'),
      b.as(Records.id, alias),
    ])

    expect(await selected.execute()).toEqual([{ [alias]: 'A', __stratom_c0: 1 }])
    expect(from.compile().sql).not.toContain('\0')
    expect(from.select(['']).compile().sql).toContain('empty_property')

    expect(from.compile().resultProjection?.map((item) => item.outputName)).toEqual([
      property,
      '',
    ])
  })
}

it('should count PostgreSQL physical identifiers in bytes but allow long application properties', () => {
  const key = '\u754c'.repeat(24)
  const mapped = defineTable(
    'long',
    { [key]: pipe(string(), column({ name: 'short' })) },
    { primaryKey: key },
  )

  expect(() => validateColumnNames([mapped], postgresDialect)).not.toThrow()
  const invalid = defineTable(
    'long',
    { property: pipe(string(), column({ name: key })) },
    { primaryKey: 'property' },
  )

  expect(() => validateColumnNames([invalid], postgresDialect)).toThrow(/property/)
})
