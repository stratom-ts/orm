import { describe, expect, it } from 'vitest'

import type {
  PostgresCreateTableAst as CreateTableAst,
  PostgresCreateTableColumnAst as CreateTableColumnAst,
} from '@/dialects/postgres/migration/ast'
import { compilePostgresDdl } from '@/dialects/postgres/migration/sql'
import {
  assertSafePostgresDataType,
  formatPostgresLiteral,
} from '@/dialects/postgres/validate'
import { SchemaError } from '@/utils/error'

/** Builds a fresh table handle for the schema scenario. */
function createTable(...columns: CreateTableColumnAst[]): CreateTableAst {
  return {
    kind: 'create_table',
    table: 't',
    schema: 'public',
    columns,
    primaryKey: ['id'],
  }
}

/** Builds a text column AST with optional storage and constraint overrides. */
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

/** Lowers an explicit literal for the DDL compiler fixture. */
function literalDefault(value: string | number | boolean | null) {
  const sql = formatPostgresLiteral(value)
  return { sql, normalized: sql }
}

const compile = compilePostgresDdl

const registerValidationCases1 = () => {
  it('should tag unsafe types, unsupported types, and non-finite defaults as schema errors', () => {
    expect(() => assertSafePostgresDataType('text; drop table users')).toThrow(
      SchemaError,
    )

    expect(() => assertSafePostgresDataType('unknown_type')).toThrow(SchemaError)

    expect(() => formatPostgresLiteral(Number.POSITIVE_INFINITY)).toThrow(SchemaError)
  })
}

const registerValidationCases2 = () => {
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
    expect(() => compile(createTable(col('x', { dataType: 'varchar(255);--' })))).toThrow(
      /unsafe column data type/,
    )
  })

  it('should reject empty data type', () => {
    expect(() => compile(createTable(col('x', { dataType: '' })))).toThrow(
      /non-empty string/,
    )
  })

  it('should reject unknown data type', () => {
    expect(() => compile(createTable(col('x', { dataType: 'foobar' })))).toThrow(
      /unsupported/,
    )
  })
}

const registerValidationCases3 = () => {
  it('should reject via alter_column_type path', () => {
    expect(() =>
      compile({
        kind: 'alter_column_type',
        table: 't',
        schema: 'public',
        column: 'x',
        dataType: 'evil(); drop table x',
      }),
    ).toThrow(/unsafe|unsupported/)
  })

  it('should accept valid type via alter_column_type path', () => {
    const sql = compile({
      kind: 'alter_column_type',
      table: 't',
      schema: 'public',
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
        schema: 'public',
        column: col('x', { dataType: 'text; drop table y' }),
      }),
    ).toThrow(/unsafe/)
  })
}

const registerValidationCases4 = () => {
  it('should emit now() unquoted in default', () => {
    const sql = compile(
      createTable(
        col('id', { dataType: 'uuid' }),
        col('ts', {
          dataType: 'timestamptz',
          databaseDefault: { sql: 'now()', normalized: 'now()' },
        }),
      ),
    ).sql.toLowerCase()

    expect(sql).toContain('default now()')
    expect(sql).not.toContain("default 'now()'")
  })

  it('should emit gen_random_uuid() unquoted', () => {
    const sql = compile(
      createTable(
        col('id', {
          dataType: 'uuid',
          databaseDefault: { sql: 'gen_random_uuid()', normalized: 'gen_random_uuid()' },
        }),
      ),
    ).sql.toLowerCase()

    expect(sql).toContain('default gen_random_uuid()')
  })

  it('should emit current_timestamp unquoted', () => {
    const sql = compile(
      createTable(
        col('ts', {
          dataType: 'timestamptz',
          databaseDefault: { sql: 'current_timestamp', normalized: 'current_timestamp' },
        }),
      ),
    ).sql.toLowerCase()

    expect(sql).toContain('default current_timestamp')
  })

  it('should preserve explicitly lowered expressions', () => {
    const sql = compile(
      createTable(
        col('ts', {
          dataType: 'timestamptz',
          databaseDefault: { sql: 'NOW()', normalized: 'NOW()' },
        }),
      ),
    ).sql.toLowerCase()

    expect(sql).toContain('default now()')
  })
}

const registerValidationCases5 = () => {
  it('should emit null, true, false as SQL literals', () => {
    const sql = compile(
      createTable(
        col('a', {
          dataType: 'text',
          databaseDefault: literalDefault(null),
        }),
        col('b', {
          dataType: 'boolean',
          databaseDefault: literalDefault(true),
        }),
        col('c', {
          dataType: 'boolean',
          databaseDefault: literalDefault(false),
        }),
      ),
    ).sql.toLowerCase()

    expect(sql).toContain('default null')
    expect(sql).toContain('default true')
    expect(sql).toContain('default false')
  })

  it('should emit numeric defaults as literals', () => {
    const sql = compile(
      createTable(
        col('n', {
          dataType: 'integer',
          databaseDefault: literalDefault(42),
        }),
      ),
    ).sql.toLowerCase()

    expect(sql).toContain('default 42')
  })

  it('should escape single quotes in string defaults', () => {
    const sql = compile(
      createTable(
        col('n', {
          dataType: 'text',
          databaseDefault: literalDefault("O'Brien"),
        }),
      ),
    ).sql

    expect(sql).toContain("default 'O''Brien'")
  })
}

const registerValidationCases6 = () => {
  it('should preserve pre-normalized database defaults during compilation', () => {
    const sql = compile(
      createTable(
        col('n', {
          dataType: 'text',
          databaseDefault: {
            sql: "E'path\\\\'",
            normalized: "E'path\\\\'",
          },
        }),
      ),
    ).sql

    expect(sql).toContain("default E'path\\\\'")
  })

  it('should quote unknown string defaults to prevent SQL execution', () => {
    const sql = compile(
      createTable(
        col('n', {
          dataType: 'text',
          databaseDefault: literalDefault('drop table users'),
        }),
      ),
    ).sql

    expect(sql).toContain("default 'drop table users'")
  })
}

const registerValidationCases7 = () => {
  it('should quote strings that look like injection attempts', () => {
    const sql = compile(
      createTable(
        col('n', {
          dataType: 'text',
          databaseDefault: literalDefault('now(); select 1'),
        }),
      ),
    ).sql

    expect(sql).toContain("default 'now(); select 1'")
  })
}

function registerValidationGroup1() {
  describe('PostgreSQL SQL safety', () => {
    registerValidationCases1()
  })
}

function registerValidationGroup2() {
  describe('PostgreSQL SQL safety', () => {
    registerValidationCases2()
  })
}

function registerValidationGroup3() {
  describe('PostgreSQL SQL safety', () => {
    registerValidationCases3()
  })
}

function registerValidationGroup4() {
  describe('PostgreSQL SQL safety', () => {
    registerValidationCases4()
  })
}

function registerValidationGroup5() {
  describe('PostgreSQL SQL safety', () => {
    registerValidationCases5()
  })
}

function registerValidationGroup6() {
  describe('PostgreSQL SQL safety', () => {
    registerValidationCases6()
  })
}

function registerValidationGroup7() {
  describe('PostgreSQL SQL safety', () => {
    registerValidationCases7()
  })
}

describe('PostgreSQL validation', () => {
  registerValidationGroup1()
  registerValidationGroup2()
  registerValidationGroup3()
  registerValidationGroup4()
  registerValidationGroup5()
  registerValidationGroup6()
  registerValidationGroup7()
})
