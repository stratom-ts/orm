import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { buildCreateTableAst } from '@/ddl'
import { defineTable } from '@/defineTable'
import {
  assertSafePostgresDataType,
  formatPostgresDefault,
  postgresDialect,
} from '@/dialects'
import { column } from '@/schemas'

describe('assertSafePostgresDataType', () => {
  it('should accept common types and length/precision forms', () => {
    expect(assertSafePostgresDataType('text')).toBe('text')
    expect(assertSafePostgresDataType('UUID')).toBe('uuid')
    expect(assertSafePostgresDataType('varchar(255)')).toBe('varchar(255)')
    expect(assertSafePostgresDataType('numeric(10, 2)')).toBe('numeric(10,2)')
    expect(assertSafePostgresDataType('timestamp with time zone')).toBe(
      'timestamp with time zone',
    )
  })

  it('should reject injection and unknown types', () => {
    expect(() => assertSafePostgresDataType('text; drop table users')).toThrow(
      /unsafe|unsupported/,
    )
    expect(() => assertSafePostgresDataType('foobar')).toThrow(/unsupported/)
    expect(() => assertSafePostgresDataType('varchar(255);--')).toThrow()
    expect(() => assertSafePostgresDataType('')).toThrow()
  })
})

describe('formatPostgresDefault', () => {
  it('should format scalars as SQL literals', () => {
    expect(formatPostgresDefault(null)).toBe('null')
    expect(formatPostgresDefault(true)).toBe('true')
    expect(formatPostgresDefault(42)).toBe('42')
    expect(formatPostgresDefault("O'Brien")).toBe("'O''Brien'")
  })

  it('should emit allowlisted expressions unquoted', () => {
    expect(formatPostgresDefault('now()')).toBe('now()')
    expect(formatPostgresDefault('NOW()')).toBe('now()')
    expect(formatPostgresDefault('current_timestamp')).toBe('current_timestamp')
    expect(formatPostgresDefault('gen_random_uuid()')).toBe('gen_random_uuid()')
  })

  it('should quote unknown strings so they are not executed as SQL', () => {
    expect(formatPostgresDefault('drop table users')).toBe("'drop table users'")
    expect(formatPostgresDefault('now(); select 1')).toBe("'now(); select 1'")
  })
})

describe('create table compile uses safe type/default paths', () => {
  it('should compile now() default without string quotes', () => {
    const T = defineTable(
      'events',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        createdAt: pipe(
          string(),
          column({ type: 'timestamptz', default: 'now()' }),
        ),
      },
      { primaryKey: 'id' },
    )

    const sql = postgresDialect
      .compile(buildCreateTableAst(T, postgresDialect))
      .sql.toLowerCase()

    expect(sql).toContain('default now()')
    expect(sql).not.toContain("default 'now()'")
  })

  it('should throw when column type is not allowlisted', () => {
    const T = defineTable(
      't',
      {
        id: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id' },
    )

    const ast = buildCreateTableAst(T, postgresDialect)

    const bad = {
      ...ast,
      columns: [{ ...ast.columns[0]!, dataType: 'evil(); drop table x' }],
    }

    expect(() => postgresDialect.compile(bad)).toThrow(/unsafe|unsupported/)
  })
})
