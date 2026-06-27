import {
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
  picklist,
  pipe,
  string,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { inferPostgresType } from '@/helpers'

describe('postgres.ts', () => {
  describe('inferPostgresType - string schemas', () => {
    it('should return text for string schema without constraints', () => {
      const schema = string()
      expect(inferPostgresType(schema)).toBe('text')
    })

    it('should return varchar with maxLength for string with maxLength <= 255', () => {
      const schema = pipe(string(), maxLength(100))
      expect(inferPostgresType(schema)).toBe('varchar(100)')
    })

    it('should return text for string with maxLength > 255', () => {
      const schema = pipe(string(), maxLength(500))
      expect(inferPostgresType(schema)).toBe('text')
    })

    it('should return char for fixed length string (minLength === maxLength)', () => {
      const schema = pipe(string(), length(10))
      expect(inferPostgresType(schema)).toBe('char(10)')
    })

    it('should return varchar for string with both minLength and maxLength within 255', () => {
      const schema = pipe(string(), minLength(5), maxLength(10))
      expect(inferPostgresType(schema)).toBe('varchar(10)')
    })
  })

  describe('inferPostgresType - number schemas', () => {
    it('should return real for number without constraints', () => {
      const schema = number()
      expect(inferPostgresType(schema)).toBe('real')
    })

    it('should return smallint for numbers in smallint range', () => {
      const schema = pipe(number(), minValue(0), maxValue(100))
      const result = inferPostgresType(schema)
      expect(result).toBe('smallint')
    })

    it('should return integer for numbers in integer range', () => {
      const schema = pipe(number(), minValue(-1000000), maxValue(1000000))
      expect(inferPostgresType(schema)).toBe('integer')
    })

    it('should return smallint for numbers in smallint range', () => {
      const schema = pipe(number(), minValue(0), maxValue(32767))
      expect(inferPostgresType(schema)).toBe('smallint')
    })

    it('should return bigint for integer numbers outside integer range', () => {
      const schema = pipe(
        number(),
        integer(),
        minValue(-10000000000),
        maxValue(10000000000),
      )
      expect(inferPostgresType(schema)).toBe('bigint')
    })
  })

  describe('inferPostgresType - literal schemas', () => {
    it('should return text for string literal', () => {
      const schema = literal('active')
      expect(inferPostgresType(schema)).toBe('text')
    })

    it('should return integer for integer literal', () => {
      const schema = literal(42)
      expect(inferPostgresType(schema)).toBe('integer')
    })

    it('should return real for float literal', () => {
      const schema = literal(3.14)
      expect(inferPostgresType(schema)).toBe('real')
    })

    it('should return boolean for boolean literal', () => {
      const schema = literal(true)
      expect(inferPostgresType(schema)).toBe('boolean')
    })
  })

  describe('inferPostgresType - other types', () => {
    it('should return timestamp for date schema', () => {
      const schema = date()
      expect(inferPostgresType(schema)).toBe('timestamp')
    })

    it('should return bigint for bigint schema', () => {
      const schema = bigint()
      expect(inferPostgresType(schema)).toBe('bigint')
    })

    it('should return boolean for boolean schema', () => {
      const schema = boolean()
      expect(inferPostgresType(schema)).toBe('boolean')
    })

    it('should return varchar(255) for enum schema', () => {
      const DirectionEnum = { Left: 'LEFT', Right: 'RIGHT' } as const
      const schema = enumSchema(DirectionEnum)
      expect(inferPostgresType(schema)).toBe('varchar(255)')
    })

    it('should return varchar(255) for picklist schema', () => {
      const schema = picklist(['active', 'inactive', 'pending'])
      expect(inferPostgresType(schema)).toBe('varchar(255)')
    })

    it('should return text for unknown schema type (default case)', () => {
      const schema = string()
      const result = inferPostgresType(
        schema as unknown as Parameters<typeof inferPostgresType>[0],
      )
      expect(result).toBe('text')
    })
  })
})
