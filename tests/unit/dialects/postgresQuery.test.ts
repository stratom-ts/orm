import {
  bigint,
  isoDateTime,
  isoDateTimeSecond,
  isoTime,
  isoTimeSecond,
  maxValue,
  minValue,
  nullable,
  number,
  pipe,
  safeInteger,
  string,
  toNumber,
  transform,
} from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { compilePostgresQuery } from '@/dialects/postgres/compile'
import {
  mapPostgresParamValue,
  mapPostgresResultValue,
} from '@/dialects/postgres/mapping'
import { column, defineTable, postgresDialect, reference } from '@/index'
import { createValueMapper } from '@/query/mapping'

const registerQueryCases1 = () => {
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
}

const registerQueryCases2 = () => {
  it('should reject a local conversion of an explicitly stored unresolved target', () => {
    const Parents = defineTable(
      'unresolved_parents',
      {
        id: pipe(
          string(),
          transform((value) => value),
          column({
            physicalType: { postgresql: 'text' },
            mapParam: (value) => value,
            mapResult: (value) => String(value),
          }),
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
}

const registerQueryCases3 = () => {
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
}

const registerQueryCases4 = () => {
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
}

function registerQueryGroup1() {
  describe('PostgreSQL reference output mapping', () => {
    registerQueryCases1()
  })
}

function registerQueryGroup2() {
  describe('PostgreSQL unresolved reference output mapping', () => {
    registerQueryCases2()
  })
}

function registerQueryGroup3() {
  describe('PostgreSQL numeric value mapping', () => {
    registerQueryCases3()
  })
}

function registerQueryGroup4() {
  describe('PostgreSQL query compilation', () => {
    registerQueryCases4()
  })
}

const registerQueryGroup5Data = [
  [isoTime(), isoTimeSecond(), 'time', '03:04:00', '03:04'],
  [
    isoDateTime(),
    isoDateTimeSecond(),
    'timestamp',
    '2026-01-02 03:04:00',
    '2026-01-02T03:04',
  ],
] as const

function registerQueryGroup5() {
  it.each(registerQueryGroup5Data)(
    'should preserve authored formats through nullable and chained references',
    (minute, second, type, raw, parentValue) => {
      const Parent = defineTable(
        'temporal_parent',
        { value: pipe(string(), minute) },
        { primaryKey: 'value' },
      )

      const secondReference = pipe(
        reference(Parent, 'value'),
        transform((value) => `${value}:00`),
        string(),
        second,
      )

      const Child = defineTable(
        'temporal_child',
        {
          value: secondReference,
          nullableValue: nullable(secondReference),
          matching: reference(Parent, 'value'),
        },
        { primaryKey: 'value' },
      )

      const Grandchild = defineTable(
        'temporal_chain',
        { value: reference(Child, 'value') },
        { primaryKey: 'value' },
      )

      const mapper = createValueMapper(postgresDialect, undefined, [
        Grandchild,
        Child,
        Parent,
      ])

      expect(mapper.columnTypes(Child)).toEqual({
        value: type,
        nullableValue: type,
        matching: type,
      })

      expect(mapper.columnTypes(Grandchild).value).toBe(type)
      expect(mapper.mapResultValue(Parent, 'value', raw)).toBe(parentValue)
      expect(mapper.mapResultValue(Child, 'matching', raw)).toBe(parentValue)
      expect(mapper.mapResultValue(Child, 'value', raw)).toBe(`${parentValue}:00`)
      expect(mapper.mapResultValue(Child, 'nullableValue', raw)).toBe(`${parentValue}:00`)
      expect(mapper.mapResultValue(Child, 'nullableValue', null)).toBeNull()
      expect(mapper.mapResultValue(Grandchild, 'value', raw)).toBe(`${parentValue}:00`)
    },
  )
}

function registerQueryGroup6() {
  it.each(['time(0)', 'text', 'varchar(40)'])(
    'should respect selected %s storage and ignore SQLite overrides',
    (type) => {
      const Parent = defineTable(
        'temporal_parent',
        {
          value: pipe(
            string(),
            isoTime(),
            column({ physicalType: { postgresql: type, sqlite: 'BLOB' } }),
          ),
        },
        { primaryKey: 'value' },
      )

      const Child = defineTable(
        'temporal_child',
        {
          value: pipe(
            reference(Parent, 'value'),
            transform((value) => `${value}:00`),
            string(),
            isoTimeSecond(),
            column({ physicalType: { sqlite: 'INTEGER' } }),
          ),
          selected: pipe(
            reference(Parent, 'value'),
            column({ physicalType: { postgresql: 'text' } }),
          ),
        },
        { primaryKey: 'value' },
      )

      const mapper = createValueMapper(postgresDialect, undefined, [Parent, Child])
      expect(mapper.columnTypes(Child)).toEqual({ value: type, selected: 'text' })
      expect(mapper.mapResultValue(Child, 'value', '03:04:00')).toBe('03:04:00')
      expect(mapper.mapResultValue(Child, 'selected', '03:04:00')).toBe('03:04:00')
    },
  )
}

function registerQueryGroup7() {
  it.each([
    ['column', 'column'],
    ['client', 'client'],
    ['column', 'client'],
    ['client', 'column'],
  ])(
    'should allow incompatible temporal output with paired %s parameter and %s result hooks',
    (param, result) => {
      const Parent = defineTable(
        'hook_parent',
        { value: pipe(string(), isoTime()) },
        { primaryKey: 'value' },
      )

      const Child = defineTable(
        'hook_child',
        {
          value: pipe(
            reference(Parent, 'value'),
            transform((value) => `2026-01-02T${value}:00`),
            string(),
            isoDateTimeSecond(),
            column({
              ...(param === 'column' ? { mapParam: () => '03:04' } : {}),
              ...(result === 'column' ? { mapResult: () => '2026-01-02T03:04:00' } : {}),
            }),
          ),
        },
        { primaryKey: 'value' },
      )

      const mapper = createValueMapper(
        postgresDialect,
        {
          ...(param === 'client' ? { mapParamValue: () => '03:04' } : {}),
          ...(result === 'client' ? { mapResultValue: () => '2026-01-02T03:04:00' } : {}),
        },
        [Parent, Child],
      )

      expect(mapper.mapParam(Child, 'value', '2026-01-02T03:04:00')).toBe('03:04')

      expect(mapper.mapResultValue(Child, 'value', '03:04:00')).toBe(
        '2026-01-02T03:04:00',
      )
    },
  )
}

function registerQueryGroup8() {
  it.each(['column parameter', 'column result', 'client parameter', 'client result'])(
    'should reject an incompatible temporal reference with only a %s hook',
    (direction) => {
      const Parent = defineTable(
        'hook_parent',
        { value: pipe(string(), isoTime()) },
        { primaryKey: 'value' },
      )

      const Child = defineTable(
        'hook_child',
        {
          value: pipe(
            reference(Parent, 'value'),
            column({
              physicalType: { postgresql: 'timestamp' },
              ...(direction === 'column parameter' ? { mapParam: () => '03:04' } : {}),
              ...(direction === 'column result' ? { mapResult: () => '03:04' } : {}),
            }),
          ),
        },
        { primaryKey: 'value' },
      )

      expect(() =>
        createValueMapper(
          postgresDialect,
          {
            ...(direction === 'client parameter' ? { mapParamValue: () => '03:04' } : {}),
            ...(direction === 'client result' ? { mapResultValue: () => '03:04' } : {}),
          },
          [Parent, Child],
        ),
      ).toThrow(/paired column mapParam/)
    },
  )
}

function registerQueryGroup9() {
  it('should retain column hook precedence independently in each direction', () => {
    const Parent = defineTable(
      'hook_parent',
      { value: pipe(string(), isoTime()) },
      { primaryKey: 'value' },
    )

    const Child = defineTable(
      'hook_child',
      {
        value: pipe(
          reference(Parent, 'value'),
          column({
            physicalType: { postgresql: 'timestamp' },
            mapParam: () => 'column parameter',
            mapResult: () => 'column result',
          }),
        ),
      },
      { primaryKey: 'value' },
    )

    const mapParamValue = vi.fn<() => string>(() => 'client parameter')
    const mapResultValue = vi.fn<() => string>(() => 'client result')
    const mapper = createValueMapper(postgresDialect, { mapParamValue, mapResultValue }, [
      Parent,
      Child,
    ])

    expect(mapper.mapParam(Child, 'value', '03:04')).toBe('column parameter')
    expect(mapper.mapResultValue(Child, 'value', '03:04:00')).toBe('column result')
    expect(mapParamValue).not.toHaveBeenCalled()
    expect(mapResultValue).not.toHaveBeenCalled()
  })
}

describe('PostgreSQL query', () => {
  registerQueryGroup1()
  registerQueryGroup2()
  registerQueryGroup3()
  registerQueryGroup4()
  registerQueryGroup5()
  registerQueryGroup6()
  registerQueryGroup7()
  registerQueryGroup8()
  registerQueryGroup9()
})
