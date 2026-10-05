import {
  array,
  bigint,
  boolean,
  date,
  enum as enumSchema,
  exactOptional,
  integer,
  length,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nonNullable,
  nonNullish,
  nonOptional,
  number,
  object,
  picklist,
  pipe,
  record,
  string,
  undefinedable,
  union,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { SchemaError, postgresDialect } from '@/index'

const { inferColumnType } = postgresDialect.schema

describe('@/dialects/postgres', () => {
  describe('normalizeDataType', () => {
    it('should keep real and double precision distinct', () => {
      expect(postgresDialect.schema.normalizeDataType('float4')).toBe('real')
      expect(postgresDialect.schema.normalizeDataType('real')).toBe('real')
      expect(postgresDialect.schema.normalizeDataType('float8')).toBe('double precision')

      expect(postgresDialect.schema.normalizeDataType('double precision')).toBe(
        'double precision',
      )
    })

    it('normalizes a default value to the catalog comparison key', () => {
      expect(postgresDialect.schema.normalizeDefaultValue?.('pending')).toBe("'pending'")
    })
  })
})

describe('@/dialects/postgres: inferColumnType - string schemas', () => {
  describe('inferColumnType - string schemas', () => {
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
})

describe('@/dialects/postgres: inferColumnType - number schemas', () => {
  describe('inferColumnType - number schemas', () => {
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
      expect(inferColumnType(pipe(number(), integer(), maxValue(1000000)))).toBe(
        'integer',
      )
    })

    it('should narrow to smallint only when both bounds fit int16', () => {
      expect(
        inferColumnType(pipe(number(), integer(), minValue(0), maxValue(32767))),
      ).toBe('smallint')
    })

    it('should widen to bigint when a bound falls outside int32', () => {
      expect(
        inferColumnType(
          pipe(number(), integer(), minValue(-10000000000), maxValue(10000000000)),
        ),
      ).toBe('bigint')
    })
  })
})

describe('@/dialects/postgres: inferColumnType - literal schemas', () => {
  describe('inferColumnType - literal schemas', () => {
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
})

describe('@/dialects/postgres: inferColumnType - literal schemas: inferColumnType - other types', () => {
  describe('inferColumnType - other types', () => {
    it('should return timestamptz for date schema', () => {
      expect(inferColumnType(date())).toBe('timestamptz')
    })

    it('should return bigint for bigint schema', () => {
      expect(inferColumnType(bigint())).toBe('bigint')
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
})
