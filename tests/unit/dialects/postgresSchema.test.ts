import {
  array,
  bigint,
  boolean,
  date,
  decimal,
  email,
  enum as enumSchema,
  exactOptional,
  integer,
  ip,
  ipv4,
  ipv6,
  isoDate,
  isoDateTime,
  isoDateTimeSecond,
  isoTime,
  isoTimeSecond,
  isoTimestamp,
  length,
  literal,
  mac,
  mac48,
  mac64,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  nullish,
  number,
  object,
  parseBoolean,
  parseJson,
  picklist,
  pipe,
  record,
  regex,
  safeInteger,
  safeParse,
  string,
  toBoolean,
  toDate,
  toNumber,
  toString,
  undefinedable,
  union,
  uuid,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { SchemaError, postgresDialect } from '@/index'
import { attemptSync } from '@/utils/error'

const { inferColumnType } = postgresDialect.schema

describe('PostgreSQL schema', () => {
  it.each([
    [isoDate(), 'date'],
    [isoTime(), 'time'],
    [isoTimeSecond(), 'time'],
    [isoDateTime(), 'timestamp'],
    [isoDateTimeSecond(), 'timestamp'],
    [isoTimestamp(), 'timestamptz'],
  ] as const)('should infer %s as %s through wrappers', (format, expected) => {
    expect(inferColumnType(nullable(pipe(string(), format)))).toBe(expected)
    expect(inferColumnType(pipe(string(), format, toDate()))).toBe('timestamptz')
  })

  it('should normalize catalog temporal aliases', () => {
    expect(postgresDialect.schema.normalizeDataType('time without time zone')).toBe(
      'time',
    )

    expect(postgresDialect.schema.normalizeDataType('timestamp without time zone')).toBe(
      'timestamp',
    )
  })

  it('should infer physical types from supported transformed outputs', () => {
    expect(inferColumnType(pipe(string(), toBoolean()))).toBe('boolean')
    expect(inferColumnType(pipe(string(), parseBoolean()))).toBe('boolean')
    expect(inferColumnType(pipe(string(), toDate()))).toBe('timestamptz')
    expect(inferColumnType(pipe(number(), toString()))).toBe('text')

    expect(
      inferColumnType(pipe(string(), parseJson(), object({ value: number() }))),
    ).toBe('jsonb')

    expect(() => inferColumnType(pipe(string(), parseJson()))).toThrow(/physicalType/)
  })

  it('should keep real and double precision distinct', () => {
    expect(postgresDialect.schema.normalizeDataType('float4')).toBe('real')
    expect(postgresDialect.schema.normalizeDataType('real')).toBe('real')
    expect(postgresDialect.schema.normalizeDataType('float8')).toBe('double precision')

    expect(postgresDialect.schema.normalizeDataType('double precision')).toBe(
      'double precision',
    )
  })

  it('should normalize a default value to the catalog comparison key', () => {
    expect(postgresDialect.schema.normalizeDefaultValue?.('pending')).toBe("'pending'")
  })
})

describe('PostgreSQL schema', () => {
  it('should infer UUID through wrappers and nested pipes before length storage', () => {
    const schemas = [
      pipe(string(), uuid()),
      pipe(string(), uuid(), maxLength(36)),
      pipe(string(), maxLength(36), uuid()),
      pipe(string(), length(36), uuid()),
      pipe(string(), minLength(36), maxLength(36), uuid()),
      pipe(string(), uuid(), minLength(36), maxLength(36)),
      pipe(pipe(string(), maxLength(36)), uuid()),
      pipe(pipe(string(), uuid()), maxLength(36)),
      pipe(string(), uuid(), uuid()),
      nullable(pipe(string(), uuid())),
      nullish(pipe(string(), uuid())),
      pipe(nonNullable(nullable(string())), uuid(), maxLength(36)),
      exactOptional(pipe(string(), uuid())),
      undefinedable(pipe(string(), uuid())),
      nonOptional(pipe(string(), uuid())),
      nonNullish(pipe(string(), uuid())),
    ]

    for (const schema of schemas) expect(inferColumnType(schema)).toBe('uuid')
  })

  it('should keep Valibot length validation active even when UUID storage wins', () => {
    const schema = pipe(string(), uuid(), maxLength(35))
    expect(inferColumnType(schema)).toBe('uuid')

    expect(safeParse(schema, '550e8400-e29b-41d4-a716-446655440000').success).toBe(false)
  })

  it('should keep other validators on ordinary string storage', () => {
    expect(inferColumnType(pipe(string(), email()))).toBe('text')
    expect(inferColumnType(pipe(string(), regex(/^[a-z]+$/)))).toBe('text')
    expect(inferColumnType(pipe(string(), email(), maxLength(60)))).toBe('varchar(60)')
  })
})

describe('PostgreSQL schema', () => {
  it('should return text for string schema without constraints', () => {
    expect(inferColumnType(string())).toBe('text')
  })

  it('should return varchar at the maxLength 255 boundary', () => {
    expect(inferColumnType(pipe(string(), maxLength(255)))).toBe('varchar(255)')
  })

  it('should return text above the maxLength 255 boundary', () => {
    expect(inferColumnType(pipe(string(), maxLength(256)))).toBe('text')
  })

  it('should return varchar (not char) for fixed length string', () => {
    expect(inferColumnType(pipe(string(), length(10)))).toBe('varchar(10)')
  })

  it('should return varchar for string with both minLength and maxLength within 255', () => {
    expect(inferColumnType(pipe(string(), minLength(5), maxLength(10)))).toBe(
      'varchar(10)',
    )
  })

  it('should preserve constraints through every wrapper family', () => {
    const schemas = [
      exactOptional(pipe(string(), maxLength(40))),
      undefinedable(pipe(string(), maxLength(40))),
      nonOptional(pipe(string(), maxLength(40))),
      nonNullable(pipe(string(), maxLength(40))),
      nonNullish(pipe(string(), maxLength(40))),
    ]

    for (const schema of schemas) expect(inferColumnType(schema)).toBe('varchar(40)')
  })
})

describe('PostgreSQL schema', () => {
  it('should return double precision for a plain number (JS numbers are doubles)', () => {
    expect(inferColumnType(number())).toBe('double precision')
  })

  it('should return double precision for a bounded but non-integer number', () => {
    // No integer() means a float in the range is valid, so it must not narrow.
    expect(inferColumnType(pipe(number(), minValue(0), maxValue(100)))).toBe(
      'double precision',
    )
  })

  it('should default integer() to integer', () => {
    expect(inferColumnType(pipe(number(), integer()))).toBe('integer')
  })

  it('should keep integer for a single-sided bound within int32', () => {
    expect(inferColumnType(pipe(number(), integer(), maxValue(1000000)))).toBe('integer')
  })

  it('should narrow to smallint only when both bounds fit int16', () => {
    expect(inferColumnType(pipe(number(), integer(), minValue(0), maxValue(32767)))).toBe(
      'smallint',
    )
  })

  it('should widen to bigint when a bound falls outside int32', () => {
    expect(
      inferColumnType(
        pipe(number(), integer(), minValue(-10000000000), maxValue(10000000000)),
      ),
    ).toBe('bigint')
  })

  it('should infer transformed number output from post-transform bounds', () => {
    expect(
      inferColumnType(pipe(string(), toNumber(), integer(), minValue(0), maxValue(100))),
    ).toBe('smallint')

    expect(inferColumnType(pipe(string(), toNumber(), safeInteger()))).toBe('bigint')
  })
})

describe('PostgreSQL schema', () => {
  it('should return text for string literal', () => {
    expect(inferColumnType(literal('active'))).toBe('text')
  })

  it('should return integer for integer literal', () => {
    expect(inferColumnType(literal(42))).toBe('integer')
  })

  it('should return double precision for float literal', () => {
    expect(inferColumnType(literal(3.14))).toBe('double precision')
  })

  it('should return boolean for boolean literal', () => {
    expect(inferColumnType(literal(true))).toBe('boolean')
  })
})

describe('PostgreSQL schema', () => {
  it('should return timestamptz for date schema', () => {
    expect(inferColumnType(date())).toBe('timestamptz')
  })

  it('should use numeric for unbounded bigint schema', () => {
    expect(inferColumnType(bigint())).toBe('numeric')

    expect(
      inferColumnType(pipe(bigint(), minValue(-(2n ** 63n)), maxValue(2n ** 63n - 1n))),
    ).toBe('bigint')
  })

  it('should return boolean for boolean schema', () => {
    expect(inferColumnType(boolean())).toBe('boolean')
  })

  it('should return text for enum schema', () => {
    const DirectionEnum = { Left: 'LEFT', Right: 'RIGHT' } as const
    expect(inferColumnType(enumSchema(DirectionEnum))).toBe('text')
  })

  it('should return text for picklist schema', () => {
    expect(inferColumnType(picklist(['active', 'inactive', 'pending']))).toBe('text')
  })

  it('should return jsonb for object schemas', () => {
    expect(inferColumnType(object({ a: string(), b: number() }))).toBe('jsonb')
  })

  it('should return jsonb for array schemas', () => {
    expect(inferColumnType(array(string()))).toBe('jsonb')
  })

  it('should return jsonb for record schemas', () => {
    expect(inferColumnType(record(string(), number()))).toBe('jsonb')
  })

  it('should throw for a schema type it cannot map', () => {
    const schema = union([string(), number()])

    expect(() => inferColumnType(schema)).toThrow(SchemaError)
    expect(() => inferColumnType(schema)).toThrow(/cannot infer a SQL column type/)
  })
})

describe('PostgreSQL schema', () => {
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
})

describe('PostgreSQL schema', () => {
  const nativeTargets = [uuid(), ip(), mac48(), mac64(), decimal()] as const
  const conflicts = nativeTargets.flatMap((first, index) =>
    nativeTargets.slice(index + 1).map((second) => ({ first, second })),
  )

  it.each(conflicts)(
    'should reject $first.type with $second.type in either order',
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
    },
  )

  it.each(['inet', 'macaddr', 'macaddr8', 'numeric'])(
    'should normalize %s to a stable catalog comparison key',
    (type) => {
      expect(postgresDialect.schema.normalizeDataType(` ${type.toUpperCase()} `)).toBe(
        type,
      )

      expect(postgresDialect.schema.normalizeDataType(type)).toBe(type)
    },
  )
})
