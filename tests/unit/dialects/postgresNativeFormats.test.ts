import {
  decimal,
  ip,
  ipv4,
  ipv6,
  length,
  mac,
  mac48,
  mac64,
  maxLength,
  minLength,
  nullable,
  number,
  pipe,
  string,
  toNumber,
  toString,
  uuid,
} from 'valibot'
import { expect, it } from 'vitest'

import { SchemaError, postgresDialect, sqliteDialect } from '@/index'
import { attemptSync } from '@/utils/error'

const { inferColumnType } = postgresDialect.schema
const formats = [
  [uuid(), 'uuid'],
  [ip(), 'inet'],
  [ipv4(), 'inet'],
  [ipv6(), 'inet'],
  [mac48(), 'macaddr'],
  [mac(), 'macaddr8'],
  [mac64(), 'macaddr8'],
  [decimal(), 'numeric'],
] as const

it.each(formats)('should infer %s as %s before length storage', (format, expected) => {
  const schemas = [
    pipe(string(), format),
    pipe(string(), format, format),
    nullable(pipe(string(), format)),
    pipe(string(), maxLength(80), format),
    pipe(string(), format, minLength(1), maxLength(80)),
    pipe(pipe(string(), length(36)), format),
    pipe(number(), toString(), format),
  ]

  for (const schema of schemas) {
    expect(inferColumnType(schema)).toBe(expected)
    expect(sqliteDialect.schema.inferColumnType(schema)).toBe('TEXT')
  }

  expect(inferColumnType(pipe(string(), format, toNumber()))).toBe('double precision')
  expect(inferColumnType(pipe(string(), format, string()))).toBe('text')
  expect(inferColumnType(pipe(string(), format, string(), decimal()))).toBe('numeric')
})

it('should accept different validators that select the same native storage in either order', () => {
  expect(inferColumnType(pipe(string(), ip(), ipv4(), ipv6()))).toBe('inet')
  expect(inferColumnType(pipe(string(), ipv6(), ipv4(), ip()))).toBe('inet')
  expect(inferColumnType(pipe(string(), mac(), mac64()))).toBe('macaddr8')
  expect(inferColumnType(pipe(string(), mac64(), mac()))).toBe('macaddr8')
})

const nativeTargets = [uuid(), ip(), mac48(), mac64(), decimal()] as const
const conflicts = nativeTargets.flatMap((first, index) =>
  nativeTargets.slice(index + 1).map((second) => ({ first, second })),
)

it.each(conflicts)(
  'should reject $first.type with $second.type in either order only for PostgreSQL',
  ({ first, second }) => {
    const forward = pipe(string(), first, second)
    const reverse = pipe(string(), second, first)
    const a = attemptSync(() => inferColumnType(forward))
    const b = attemptSync(() => inferColumnType(reverse))
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)

    if (a.ok || b.ok) throw new Error('Expected conflicting formats to fail')

    expect(a.error).toBeInstanceOf(SchemaError)
    expect(b.error).toBeInstanceOf(SchemaError)

    if (!(a.error instanceof SchemaError) || !(b.error instanceof SchemaError))
      throw new Error('Expected SchemaError')

    expect(b.error.message).toBe(a.error.message)

    expect(a.error.message).toContain(
      'Use one format or column({ physicalType: { postgresql: ... } })',
    )

    expect(sqliteDialect.schema.inferColumnType(forward)).toBe('TEXT')
    expect(sqliteDialect.schema.inferColumnType(reverse)).toBe('TEXT')
  },
)

it.each(['inet', 'macaddr', 'macaddr8', 'numeric'])(
  'should normalize %s to a stable catalog comparison key',
  (type) => {
    expect(postgresDialect.schema.normalizeDataType(` ${type.toUpperCase()} `)).toBe(type)

    expect(postgresDialect.schema.normalizeDataType(type)).toBe(type)
  },
)
