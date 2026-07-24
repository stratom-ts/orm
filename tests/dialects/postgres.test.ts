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
import type { CreateTableAst, CreateTableColumnAst } from '@/dialects/types'
import { SchemaError } from '@/utils/error'

function createTable(...columns: CreateTableColumnAst[]): CreateTableAst {
  return {
    kind: 'create_table',
    table: 't',
    columns,
    primaryKey: ['id'],
  }
}

function col(
  name: string,
  overrides: Partial<CreateTableColumnAst> = {},
): CreateTableColumnAst {
  return {
    name,
    dataType: 'text',
    notNull: false,
    unique: false,
    autoIncrement: false,
    ...overrides,
  }
}

const { inferColumnType, compile } = postgresDialect

describe('@/dialects/postgres', () => {
  describe('normalizeDataType', () => {
    it('should keep real and double precision distinct', () => {
      expect(postgresDialect.normalizeDataType('float4')).toBe('real')
      expect(postgresDialect.normalizeDataType('real')).toBe('real')
      expect(postgresDialect.normalizeDataType('float8')).toBe('double precision')
      expect(postgresDialect.normalizeDataType('double precision')).toBe(
        'double precision',
      )
    })
  })

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

  describe('ddl safety — type validation via compile', () => {
    it('should accept common types and normalize casing', () => {
      const sql = compile(
        createTable(
          col('a', { dataType: 'text' }),
          col('b', { dataType: 'UUID' }),
          col('c', { dataType: 'varchar(255)' }),
          col('d', { dataType: 'numeric(10, 2)' }),
          col('e', { dataType: 'timestamp with time zone' }),
        ),
      ).sql.toLowerCase()

      expect(sql).toContain('"a" text')
      expect(sql).toContain('"b" uuid')
      expect(sql).toContain('"c" varchar(255)')
      expect(sql).toContain('"d" numeric(10,2)')
      expect(sql).toContain('"e" timestamp with time zone')
    })

    it('should reject SQL injection in data type', () => {
      expect(() =>
        compile(createTable(col('x', { dataType: 'text; drop table users' }))),
      ).toThrow(/unsafe/)
    })

    it('should reject semicolon-comment injection', () => {
      expect(() =>
        compile(createTable(col('x', { dataType: 'varchar(255);--' }))),
      ).toThrow()
    })

    it('should reject empty data type', () => {
      expect(() => compile(createTable(col('x', { dataType: '' })))).toThrow()
    })

    it('should reject unknown data type', () => {
      expect(() => compile(createTable(col('x', { dataType: 'foobar' })))).toThrow(
        /unsupported/,
      )
    })

    it('should reject via alter_column_type path', () => {
      expect(() =>
        compile({
          kind: 'alter_column_type',
          table: 't',
          column: 'x',
          dataType: 'evil(); drop table x',
        }),
      ).toThrow(/unsafe|unsupported/)
    })

    it('should accept valid type via alter_column_type path', () => {
      const sql = compile({
        kind: 'alter_column_type',
        table: 't',
        column: 'x',
        dataType: 'integer',
      }).sql.toLowerCase()

      expect(sql).toContain('type integer')
    })

    it('should reject via add_column path', () => {
      expect(() =>
        compile({
          kind: 'add_column',
          table: 't',
          column: col('x', { dataType: 'text; drop table y' }),
        }),
      ).toThrow(/unsafe/)
    })
  })

  describe('ddl safety — default value formatting via compile', () => {
    it('should emit now() unquoted in default', () => {
      const sql = compile(
        createTable(
          col('id', { dataType: 'uuid' }),
          col('ts', { dataType: 'timestamptz', defaultValue: 'now()' }),
        ),
      ).sql.toLowerCase()

      expect(sql).toContain('default now()')
      expect(sql).not.toContain("default 'now()'")
    })

    it('should emit gen_random_uuid() unquoted', () => {
      const sql = compile(
        createTable(col('id', { dataType: 'uuid', defaultValue: 'gen_random_uuid()' })),
      ).sql.toLowerCase()

      expect(sql).toContain('default gen_random_uuid()')
    })

    it('should emit current_timestamp unquoted', () => {
      const sql = compile(
        createTable(
          col('ts', { dataType: 'timestamptz', defaultValue: 'current_timestamp' }),
        ),
      ).sql.toLowerCase()

      expect(sql).toContain('default current_timestamp')
    })

    it('should case-insensitively match allowlisted expressions', () => {
      const sql = compile(
        createTable(col('ts', { dataType: 'timestamptz', defaultValue: 'NOW()' })),
      ).sql.toLowerCase()

      expect(sql).toContain('default now()')
    })

    it('should emit null, true, false as SQL literals', () => {
      const sql = compile(
        createTable(
          col('a', { dataType: 'text', defaultValue: null }),
          col('b', { dataType: 'boolean', defaultValue: true }),
          col('c', { dataType: 'boolean', defaultValue: false }),
        ),
      ).sql.toLowerCase()

      expect(sql).toContain('default null')
      expect(sql).toContain('default true')
      expect(sql).toContain('default false')
    })

    it('should emit numeric defaults as literals', () => {
      const sql = compile(
        createTable(col('n', { dataType: 'integer', defaultValue: 42 })),
      ).sql.toLowerCase()

      expect(sql).toContain('default 42')
    })

    it('should escape single quotes in string defaults', () => {
      const sql = compile(
        createTable(col('n', { dataType: 'text', defaultValue: "O'Brien" })),
      ).sql

      expect(sql).toContain("default 'O''Brien'")
    })

    it('should quote unknown string defaults to prevent SQL execution', () => {
      const sql = compile(
        createTable(col('n', { dataType: 'text', defaultValue: 'drop table users' })),
      ).sql

      expect(sql).toContain("default 'drop table users'")
    })

    it('should quote strings that look like injection attempts', () => {
      const sql = compile(
        createTable(col('n', { dataType: 'text', defaultValue: 'now(); select 1' })),
      ).sql

      expect(sql).toContain("default 'now(); select 1'")
    })
  })
})
