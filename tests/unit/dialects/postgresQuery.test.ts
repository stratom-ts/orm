import {
  bigint,
  maxValue,
  minValue,
  number,
  pipe,
  safeInteger,
  string,
  toNumber,
  transform,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { compilePostgresQuery } from '@/dialects/postgres/compile'
import {
  mapPostgresParamValue,
  mapPostgresResultValue,
} from '@/dialects/postgres/mapping'
import { column, defineTable, postgresDialect, reference } from '@/index'
import { createValueMapper } from '@/query/mapping'

describe('PostgreSQL reference output mapping', () => {
  it('should reject reference transformations that change the resolved output kind', () => {
    const Parents = defineTable('parents', { id: string() }, { primaryKey: 'id' })
    const Children = defineTable(
      'children',
      { id: pipe(reference(Parents, 'id'), toNumber()) },
      { primaryKey: 'id' },
    )

    expect(() =>
      createValueMapper(postgresDialect, undefined, [Parents, Children]),
    ).toThrow(/reference transformations/)
  })

  it('should allow references that retain a transformed target output', () => {
    const Parents = defineTable(
      'numeric_parents',
      { id: pipe(string(), toNumber(), safeInteger()) },
      { primaryKey: 'id' },
    )

    const Children = defineTable(
      'numeric_children',
      { id: reference(Parents, 'id') },
      { primaryKey: 'id' },
    )

    const mapper = createValueMapper(postgresDialect, undefined, [Parents, Children])
    expect(mapper.columnTypes(Children).id).toBe('bigint')
  })

  it('should allow incompatible local reference output with paired explicit hooks', () => {
    const Parents = defineTable('hook_parents', { id: string() }, { primaryKey: 'id' })
    const Children = defineTable(
      'hook_children',
      { id: pipe(reference(Parents, 'id'), toNumber()) },
      { primaryKey: 'id' },
    )

    expect(() =>
      createValueMapper(
        postgresDialect,
        {
          mapParamValue: (_type, value) => value,
          mapResultValue: (_type, value) => value,
        },
        [Parents, Children],
      ),
    ).not.toThrow()
  })
})

describe('PostgreSQL unresolved reference output mapping', () => {
  it('should reject a local conversion of an explicitly stored unresolved target', () => {
    const Parents = defineTable(
      'unresolved_parents',
      {
        id: pipe(
          string(),
          transform((value) => value),
          column({ physicalType: { postgresql: 'text' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const Children = defineTable(
      'unresolved_children',
      { id: pipe(reference(Parents, 'id'), toNumber()) },
      { primaryKey: 'id' },
    )

    expect(() =>
      createValueMapper(postgresDialect, undefined, [Parents, Children]),
    ).toThrow(/reference transformations/)
  })
})

describe('PostgreSQL numeric value mapping', () => {
  it('should map bigint numeric values from the effective schema without losing precision', () => {
    const schema = pipe(bigint(), minValue(-(2n ** 63n)), maxValue(2n ** 63n - 1n))
    const context = { schema }
    expect(mapPostgresParamValue('numeric', 9007199254740993n, context)).toBe(
      '9007199254740993',
    )

    expect(mapPostgresResultValue('numeric', '9007199254740993', context)).toBe(
      9007199254740993n,
    )

    expect(mapPostgresResultValue('numeric', '9007199254740993')).toBe('9007199254740993')

    expect(() => mapPostgresResultValue('numeric', '1.5', context)).toThrow(
      /represented safely/,
    )
  })

  it('should reject unsafe numeric results for number output', () => {
    const context = { schema: pipe(string(), toNumber(), safeInteger()) }
    expect(mapPostgresResultValue('bigint', '42', context)).toBe(42)

    expect(mapPostgresResultValue('numeric', '9007199254740993.0', context)).toBe(
      '9007199254740993.0',
    )

    expect(() => mapPostgresResultValue('bigint', '9007199254740993', context)).toThrow(
      /represented safely/,
    )

    expect(() => mapPostgresResultValue('bigint', 'not numeric', context)).toThrow(
      /represented safely/,
    )

    expect(mapPostgresResultValue('bigint', 42, context)).toBe(42)
    expect(mapPostgresResultValue('numeric', '1.5', { schema: number() })).toBe('1.5')
    expect(mapPostgresResultValue('numeric', '1.000', { schema: bigint() })).toBe(1n)
  })
})

describe('PostgreSQL query compilation', () => {
  it('should reject empty select and returning AST projections', () => {
    expect(() =>
      compilePostgresQuery({
        kind: 'select',
        relation: { relation: 't' },
        selection: [],
      }),
    ).toThrow(/select items must not be empty/)

    expect(() =>
      compilePostgresQuery({
        kind: 'insert',
        relation: { relation: 't' },
        columns: ['id'],
        values: [[1]],
        returning: { kind: 'columns', columns: [] },
      }),
    ).toThrow(/returning columns must not be empty/)
  })
})
