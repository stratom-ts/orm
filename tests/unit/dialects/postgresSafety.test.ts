import { describe, expect, it } from 'vitest'

import { compilePostgres } from '@/dialects/postgres/compile'
import type {
  PostgresCreateTableAst as CreateTableAst,
  PostgresCreateTableColumnAst as CreateTableColumnAst,
} from '@/dialects/postgres/migration/ast'
import {
  assertSafePostgresDataType,
  formatPostgresDefault,
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

const compile = compilePostgres

describe('PostgreSQL SQL safety', () => {
  it('tags unsafe types, unsupported types, and non-finite defaults as schema errors', () => {
    expect(() => assertSafePostgresDataType('text; drop table users')).toThrow(
      SchemaError,
    )

    expect(() => assertSafePostgresDataType('unknown_type')).toThrow(SchemaError)

    expect(() => formatPostgresDefault(Number.POSITIVE_INFINITY)).toThrow(SchemaError)
  })
})

describe('PostgreSQL SQL safety', () => {
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
})

describe('PostgreSQL SQL safety', () => {
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
})

describe('PostgreSQL SQL safety', () => {
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
})

describe('PostgreSQL SQL safety', () => {
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
})

describe('PostgreSQL SQL safety', () => {
  it('should prefer pre-normalized database defaults during compilation', () => {
    const sql = compile(
      createTable(
        col('n', {
          dataType: 'text',
          defaultValue: 'legacy',
          databaseDefault: {
            sql: "E'path\\\\'",
            normalized: "E'path\\\\'",
          },
        }),
      ),
    ).sql

    expect(sql).toContain("default E'path\\\\'")
    expect(sql).not.toContain('legacy')
  })

  it('should quote unknown string defaults to prevent SQL execution', () => {
    const sql = compile(
      createTable(col('n', { dataType: 'text', defaultValue: 'drop table users' })),
    ).sql

    expect(sql).toContain("default 'drop table users'")
  })
})

describe('PostgreSQL SQL safety', () => {
  it('should quote strings that look like injection attempts', () => {
    const sql = compile(
      createTable(col('n', { dataType: 'text', defaultValue: 'now(); select 1' })),
    ).sql

    expect(sql).toContain("default 'now(); select 1'")
  })
})
