import {
  array,
  bigint,
  boolean,
  date,
  decimal,
  email,
  enum as enumSchema,
  exactOptional,
  fallback,
  integer,
  intersect,
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
  null as nullSchema,
  nullable,
  nullish,
  number,
  object,
  optional,
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
  transform,
  undefinedable,
  union,
  uuid,
  variant,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { SchemaError, postgresDialect } from '@/index'
import { attemptSync } from '@/utils/error'

const { inferColumnType } = postgresDialect.schema

it('should infer number storage for a nullable transformed output', () => {
  expect(
    inferColumnType(
      pipe(
        string(),
        transform((value): number | null => (value === 'null' ? null : Number(value))),
        nullable(number()),
      ),
    ),
  ).toBe('double precision')
})

it('should retain bigint width from finite and composite proofs through later numeric schemas', () => {
  const schemas = [
    pipe(
      union([pipe(number(), safeInteger()), pipe(number(), safeInteger())]),
      number(),
      integer(),
    ),
    pipe(literal<number>(2147483648), number(), integer()),
    pipe(picklist([2147483648] as number[]), number(), integer()),
    pipe(picklist([2147483648, 5] as number[]), number(), integer(), maxValue(10)),
    pipe(
      union([literal<number>(2147483648), literal<number>(5)]),
      number(),
      integer(),
      maxValue(10),
    ),
    pipe(
      picklist([2147483648, 5] as number[]),
      union([number(), number()]),
      integer(),
      maxValue(10),
    ),
    pipe(
      enumSchema({ large: 2147483648, small: 5 } as Record<string, number>),
      number(),
      integer(),
      maxValue(10),
    ),
  ]

  expect(schemas.slice(0, 3).map((schema) => inferColumnType(schema))).toEqual([
    'bigint',
    'bigint',
    'bigint',
  ])

  expect(schemas.slice(3).map((schema) => inferColumnType(schema))).toEqual([
    'smallint',
    'integer',
    'smallint',
    'smallint',
  ])
})

it('should narrow finite bigint branches with later numeric bounds', () => {
  const branches = [literal<bigint>(2n ** 64n), literal<bigint>(5n)]
  const bounded = pipe(union(branches), bigint(), maxValue(10n))
  const nestedBounded = pipe(union(branches), pipe(bigint(), maxValue(10n)))

  expect([bounded, nestedBounded].map((schema) => inferColumnType(schema))).toEqual([
    'bigint',
    'bigint',
  ])
})

it('should retain nested safe-integer branch proofs through later numeric schemas', () => {
  const schema = pipe(
    union([
      union([pipe(number(), safeInteger()), pipe(number(), safeInteger())]),
      union([pipe(number(), safeInteger()), pipe(number(), safeInteger())]),
    ]),
    number(),
    integer(),
  )

  expect(inferColumnType(schema)).toBe('bigint')
})

describe('PostgreSQL schema', () => {
  it('should widen compatible composite storage and retain nullability independently', () => {
    expect(
      inferColumnType(
        union([
          pipe(number(), integer(), minValue(0), maxValue(10)),
          pipe(number(), integer()),
        ]),
      ),
    ).toBe('integer')

    expect(
      inferColumnType(
        union([pipe(string(), maxLength(12)), pipe(string(), maxLength(40))]),
      ),
    ).toBe('varchar(40)')

    expect(inferColumnType(union([pipe(string(), maxLength(12)), string()]))).toBe('text')

    expect(inferColumnType(pipe(union([string(), string()]), maxLength(20)))).toBe(
      'varchar(20)',
    )

    expect(
      inferColumnType(union([union([nullSchema(), literal(null as never)]), string()])),
    ).toBe('text')
  })
})

describe('PostgreSQL schema', () => {
  it('should widen safe numeric branches without losing precision', () => {
    expect(inferColumnType(union([pipe(number(), safeInteger()), number()]))).toBe(
      'double precision',
    )

    expect(inferColumnType(union([literal(1), literal(2147483648)]))).toBe('bigint')
    expect(inferColumnType(union([literal(1n), literal(2n)]))).toBe('bigint')
    expect(inferColumnType(union([literal(1n), bigint()]))).toBe('numeric')

    expect(inferColumnType(union([literal(2147483648), literal(0.5)]))).toBe(
      'double precision',
    )

    expect(inferColumnType(union([picklist([2147483648]), literal(0.5)]))).toBe(
      'double precision',
    )

    expect(
      inferColumnType(
        union([
          union([pipe(number(), safeInteger()), pipe(number(), safeInteger())]),
          number(),
        ]),
      ),
    ).toBe('double precision')

    expect(
      inferColumnType(
        union([
          pipe(
            union([
              pipe(number(), integer(), minValue(2147483648)),
              pipe(number(), integer(), minValue(2147483648)),
            ]),
            safeInteger(),
          ),
          number(),
        ]),
      ),
    ).toBe('double precision')
  })
})

describe('PostgreSQL bigint composite schema', () => {
  it('should apply outer bigint bounds through compatible nested branches', () => {
    const min = -(2n ** 63n)
    const max = 2n ** 63n - 1n
    const schemas = [
      pipe(union([bigint(), bigint()]), minValue(min), maxValue(max)),
      nullable(pipe(intersect([bigint(), bigint()]), minValue(min), maxValue(max))),
      pipe(
        union([intersect([bigint(), bigint()]), union([bigint(), bigint()])]),
        minValue(min),
        maxValue(max),
      ),
      pipe(
        union([
          pipe(bigint(), minValue(min)),
          pipe(union([bigint(), bigint()]), minValue(min)),
        ]),
        maxValue(max),
      ),
      pipe(
        union([
          pipe(bigint(), minValue(min), maxValue(max)),
          pipe(bigint(), minValue(min), maxValue(max)),
        ]),
        minValue(min - 1n),
        maxValue(max + 1n),
      ),
    ]

    for (const schema of schemas) {
      expect(inferColumnType(schema)).toBe('bigint')
      expect(safeParse(schema, max)).toMatchObject({ success: true, output: max })
    }
  })
})

describe('PostgreSQL bigint composite schema', () => {
  it('should retain numeric when effective bigint branch bounds do not prove int64 storage', () => {
    const min = -(2n ** 63n)
    const max = 2n ** 63n - 1n
    const schemas = [
      union([bigint(), bigint()]),
      pipe(union([bigint(), bigint()]), minValue(min)),
      pipe(union([bigint(), bigint()]), maxValue(max)),
      pipe(union([bigint(), bigint()]), minValue(min - 1n), maxValue(max)),
      pipe(union([bigint(), bigint()]), minValue(min), maxValue(max + 1n)),
      pipe(union([pipe(bigint(), minValue(min)), bigint()]), maxValue(max)),
    ]

    for (const schema of schemas) expect(inferColumnType(schema)).toBe('numeric')
  })
})

describe('PostgreSQL bigint composite schema', () => {
  it('should reject incompatible or unresolved composite output despite outer bigint bounds', () => {
    const schemas = [
      pipe(union([bigint(), number()]), minValue(0n), maxValue(100n)),
      pipe(
        union([bigint(), pipe(bigint(), transform(String))]),
        minValue(0n),
        maxValue(100n),
      ),
    ]

    for (const schema of schemas)
      expect(() => inferColumnType(schema)).toThrow(SchemaError)
  })
})

describe('PostgreSQL numeric composite schema', () => {
  it('should apply outer numeric constraints to compatible branches', () => {
    expect(
      inferColumnType(
        pipe(
          union([pipe(number(), integer()), pipe(number(), integer())]),
          safeInteger(),
        ),
      ),
    ).toBe('bigint')

    expect(
      inferColumnType(
        pipe(
          union([
            union([pipe(number(), integer()), pipe(number(), integer())]),
            pipe(number(), integer()),
          ]),
          safeInteger(),
        ),
      ),
    ).toBe('bigint')

    expect(
      inferColumnType(
        pipe(union([number(), number()]), integer(), minValue(0), maxValue(100)),
      ),
    ).toBe('smallint')

    expect(
      inferColumnType(
        pipe(
          union([
            pipe(number(), integer(), minValue(-100), maxValue(100)),
            pipe(number(), integer(), minValue(-100), maxValue(100)),
          ]),
          minValue(-100000),
          maxValue(100000),
        ),
      ),
    ).toBe('smallint')
  })
})

describe('PostgreSQL schema', () => {
  it('should infer JSON variants and object intersections', () => {
    const schema = variant('kind', [
      object({ kind: literal('a'), value: string() }),
      variant('kind', [object({ kind: literal('b'), value: number() })]),
    ])

    expect(inferColumnType(schema)).toBe('jsonb')

    expect(
      inferColumnType(intersect([object({ a: string() }), object({ b: number() })])),
    ).toBe('jsonb')

    const nullishSchema = object({ label: nullish(string()) })
    expect(inferColumnType(union([nullishSchema, nullishSchema]))).toBe('jsonb')

    const defaulted = object({
      label: optional(pipe(date(), toString()), new Date('2026-01-01T00:00:00Z')),
    })

    expect(inferColumnType(union([defaulted, defaulted]))).toBe('jsonb')

    const defaultedUndefinedable = union([
      object({ values: array(undefinedable(string(), 'fallback')) }),
      object({ values: array(undefinedable(string(), 'fallback')) }),
    ])

    expect(inferColumnType(defaultedUndefinedable)).toBe('jsonb')
  })

  it('should reject JSON composites whose nested outputs lose identity', () => {
    for (const schema of [
      union([object({ at: date() }), object({ at: date() })]),
      union([object({ id: bigint() }), object({ id: bigint() })]),
      variant('kind', [
        object({ kind: literal('a'), at: date() }),
        object({ kind: literal('b'), at: date() }),
      ]),
      intersect([object({ at: date() }), object({ label: string() })]),
    ]) {
      expect(() => inferColumnType(schema)).toThrow(SchemaError)

      expect(() => inferColumnType(schema)).toThrow(
        /JSON composite output is not preserved.*paired parameter and result mappings/,
      )
    }
  })

  it('should reject incompatible output identities and native formats', () => {
    for (const schema of [
      union([string(), number()]),
      union([number(), bigint()]),
      union([literal(Number.MAX_SAFE_INTEGER + 1), literal(1)]),
      union([pipe(string(), uuid()), string()]),
      union([pipe(string(), isoTime()), pipe(string(), isoTimeSecond())]),
      intersect([string(), number()]),
    ])
      expect(() => inferColumnType(schema)).toThrow(SchemaError)
  })
})

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
  it('should infer homogeneous choice families from their output values', () => {
    expect(inferColumnType(enumSchema({ first: 'first', second: 'second' }))).toBe('text')
    expect(inferColumnType(picklist(['first', 'second']))).toBe('text')
    expect(inferColumnType(picklist([1, 2]))).toBe('smallint')
    expect(inferColumnType(enumSchema({ first: 1, second: 2 }))).toBe('smallint')
    expect(inferColumnType(picklist([1, 1.5]))).toBe('double precision')
    expect(inferColumnType(picklist([1.5, 1]))).toBe('double precision')
    expect(inferColumnType(picklist([1n, 2n]))).toBe('bigint')
    expect(inferColumnType(picklist([1n, 2n ** 63n]))).toBe('numeric')
  })

  it('should use the actual values of a TypeScript numeric enum', () => {
    enum Status {
      First = 1,
      Second = 2,
    }

    expect(inferColumnType(enumSchema(Status))).toBe('smallint')
  })

  it.each([
    [[-32768, 32767], 'smallint'],
    [[32767, -32768], 'smallint'],
    [[-32769, 32767], 'integer'],
    [[-32768, 32768], 'integer'],
    [[-2147483648, 2147483647], 'integer'],
    [[2147483647, -2147483648], 'integer'],
    [[-2147483649, 2147483647], 'bigint'],
    [[-2147483648, 2147483648], 'bigint'],
    [[Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], 'bigint'],
  ] as const)('should infer %s as %s from both integer extremes', (options, expected) => {
    expect(inferColumnType(picklist(options))).toBe(expected)
  })

  it('should use numeric for bigint choices outside either int64 boundary', () => {
    const min = -(2n ** 63n)
    const max = 2n ** 63n - 1n
    expect(inferColumnType(picklist([min, max]))).toBe('bigint')
    expect(inferColumnType(picklist([0n, min - 1n]))).toBe('numeric')
    expect(inferColumnType(picklist([0n, max + 1n]))).toBe('numeric')
  })
})

describe('PostgreSQL schema', () => {
  it.each([
    ['NaN', picklist([0, Number.NaN])],
    ['positive infinity', picklist([0, Number.POSITIVE_INFINITY])],
    ['negative infinity', picklist([0, Number.NEGATIVE_INFINITY])],
    ['unsafe positive integer', picklist([0, Number.MAX_SAFE_INTEGER + 1])],
    ['unsafe negative integer', picklist([0, Number.MIN_SAFE_INTEGER - 1])],
    ['fraction before unsafe integer', picklist([1.5, Number.MAX_SAFE_INTEGER + 1])],
  ])('should reject unsupported numeric choice %s', (_label, schema) => {
    expect(() => inferColumnType(schema)).toThrow(SchemaError)

    expect(() => inferColumnType(schema)).toThrow(
      /physicalType: \{ postgresql: \.\.\. \}/,
    )
  })

  it.each([picklist(['one', 1]), enumSchema({ first: 1, second: 'two' })])(
    'should reject mixed choice outputs with an actionable error',
    (schema) => {
      expect(() => inferColumnType(schema)).toThrow(SchemaError)

      expect(() => inferColumnType(schema)).toThrow(
        /physicalType: \{ postgresql: \.\.\. \}/,
      )
    },
  )

  it('should reject an empty choice with explicit-type guidance', () => {
    expect(() => inferColumnType(picklist([]))).toThrow(SchemaError)

    expect(() => inferColumnType(picklist([]))).toThrow(
      /physicalType: \{ postgresql: \.\.\. \}/,
    )
  })

  it.each([
    ['optional', optional(picklist([1, 2]))],
    ['exactOptional', exactOptional(picklist([1, 2]))],
    ['undefinedable', undefinedable(picklist([1, 2]))],
    ['nullable', nullable(picklist([1, 2]))],
    ['nullish', nullish(picklist([1, 2]))],
    ['nonOptional', nonOptional(picklist([1, 2]))],
    ['nonNullable', nonNullable(picklist([1, 2]))],
    ['nonNullish', nonNullish(picklist([1, 2]))],
    ['nested wrappers and pipe', nullable(optional(pipe(picklist([1, 2]), minValue(1))))],
  ])('should infer numeric choice storage through %s', (_name, schema) => {
    expect(inferColumnType(schema)).toBe('smallint')
  })

  it('should use the effective choice after a pipeline and clear it after a transform', () => {
    expect(inferColumnType(pipe(string(), transform(Number), picklist([1, 2])))).toBe(
      'smallint',
    )

    expect(inferColumnType(pipe(picklist([1, 2]), toString()))).toBe('text')
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
      pipe(string(), format, string()),
      pipe(string(), maxLength(80), format),
      pipe(string(), format, minLength(1), maxLength(80)),
      pipe(pipe(string(), length(36)), format),
      pipe(number(), toString(), format),
    ]

    for (const schema of schemas) expect(inferColumnType(schema)).toBe(expected)

    expect(inferColumnType(pipe(string(), format, toNumber()))).toBe('double precision')
  })

  it('should accept different validators that select the same native storage in either order', () => {
    expect(inferColumnType(pipe(string(), ip(), ipv4(), ipv6()))).toBe('inet')
    expect(inferColumnType(pipe(string(), ipv6(), ipv4(), ip()))).toBe('inet')
    expect(inferColumnType(pipe(string(), mac(), mac64()))).toBe('macaddr8')
    expect(inferColumnType(pipe(string(), mac64(), mac()))).toBe('macaddr8')
  })

  it('should retain safe-integer validation through a repeated number schema', () => {
    expect(inferColumnType(pipe(number(), safeInteger(), number(), integer()))).toBe(
      'bigint',
    )
  })

  it('should clear earlier bounds when a fallback can produce another number', () => {
    expect(
      inferColumnType(
        pipe(
          number(),
          integer(),
          minValue(0),
          maxValue(10),
          fallback(pipe(number(), minValue(20)), 100_000),
        ),
      ),
    ).toBe('double precision')
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

  it('should reject UUID with IPv4 validation across a repeated string schema', () => {
    const forward = attemptSync(() =>
      inferColumnType(pipe(string(), uuid(), string(), ipv4())),
    )

    const reverse = attemptSync(() =>
      inferColumnType(pipe(string(), ipv4(), string(), uuid())),
    )

    expect(forward.ok ? undefined : forward.error).toBeInstanceOf(SchemaError)

    expect(reverse.ok ? undefined : reverse.error).toBeInstanceOf(SchemaError)
  })
})
