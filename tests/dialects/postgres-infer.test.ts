import {
  array,
  bigint,
  boolean,
  date,
  enum as enumSchema,
  integer,
  length,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  picklist,
  pipe,
  record,
  string,
  union,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { postgresDialect } from '@/dialects/postgres'
import { SchemaError } from '@/utils/error'

const { inferColumnType } = postgresDialect

describe('@/dialects/postgres', () => {
  describe('inferColumnType - string schemas', () => {
    it('should return text for string schema without constraints', () => {
      expect(inferColumnType(string())).toBe('text')
    })

    it('should return varchar with maxLength for string with maxLength <= 255', () => {
      expect(inferColumnType(pipe(string(), maxLength(100)))).toBe('varchar(100)')
    })

    it('should return text for string with maxLength > 255', () => {
      expect(inferColumnType(pipe(string(), maxLength(500)))).toBe('text')
    })

    it('should return varchar (not char) for fixed length string', () => {
      expect(inferColumnType(pipe(string(), length(10)))).toBe('varchar(10)')
    })

    it('should return varchar for string with both minLength and maxLength within 255', () => {
      expect(inferColumnType(pipe(string(), minLength(5), maxLength(10)))).toBe(
        'varchar(10)',
      )
    })
  })

  describe('inferColumnType - number schemas', () => {
    it('should return double precision for a plain number (JS numbers are doubles)', () => {
      expect(inferColumnType(number())).toBe('double precision')
    })

    it('should return double precision for a bounded but non-integer number', () => {
      // No integer() → a float in the range is valid, so it must not narrow.
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
