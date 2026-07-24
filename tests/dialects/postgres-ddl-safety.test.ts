import {
  assertSafePostgresDataType,
  formatPostgresDefault,
  postgresDialect,
} from '@/dialects'
import { buildCreateTableAst } from '@/ddl'
import { defineTable } from '@/defineTable'
import { column, table } from '@/schemas'
import { object, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

describe('assertSafePostgresDataType', () => {
  it('accepts common types and length/precision forms', () => {
    expect(assertSafePostgresDataType('text')).toBe('text')
    expect(assertSafePostgresDataType('UUID')).toBe('uuid')
    expect(assertSafePostgresDataType('varchar(255)')).toBe('varchar(255)')
    expect(assertSafePostgresDataType('numeric(10, 2)')).toBe('numeric(10,2)')
    expect(assertSafePostgresDataType('timestamp with time zone')).toBe(
      'timestamp with time zone',
    )
  })

  it('rejects injection and unknown types', () => {
    expect(() => assertSafePostgresDataType('text; drop table users')).toThrow(
      /unsafe|unsupported/,
    )
    expect(() => assertSafePostgresDataType('foobar')).toThrow(/unsupported/)
    expect(() => assertSafePostgresDataType('varchar(255);--')).toThrow()
    expect(() => assertSafePostgresDataType('')).toThrow()
  })
})

describe('formatPostgresDefault', () => {
  it('formats scalars as SQL literals', () => {
    expect(formatPostgresDefault(null)).toBe('null')
    expect(formatPostgresDefault(true)).toBe('true')
    expect(formatPostgresDefault(42)).toBe('42')
    expect(formatPostgresDefault("O'Brien")).toBe("'O''Brien'")
  })

  it('emits allowlisted expressions unquoted', () => {
    expect(formatPostgresDefault('now()')).toBe('now()')
    expect(formatPostgresDefault('NOW()')).toBe('now()')
    expect(formatPostgresDefault('current_timestamp')).toBe('current_timestamp')
    expect(formatPostgresDefault('gen_random_uuid()')).toBe('gen_random_uuid()')
  })

  it('quotes unknown strings so they are not executed as SQL', () => {
    expect(formatPostgresDefault('drop table users')).toBe("'drop table users'")
    expect(formatPostgresDefault('now(); select 1')).toBe("'now(); select 1'")
  })
})

describe('create table compile uses safe type/default paths', () => {
  it('compiles now() default without string quotes', () => {
    const T = defineTable(
      pipe(
        object({
          id: pipe(string(), column({ type: 'uuid' })),
          createdAt: pipe(
            string(),
            column({ type: 'timestamptz', default: 'now()' }),
          ),
        }),
        title('events'),
        table({ name: 'events', primaryKey: 'id' }),
      ),
    )
    const sql = postgresDialect
      .compile(buildCreateTableAst(T, postgresDialect))
      .sql.toLowerCase()
    expect(sql).toContain('default now()')
    expect(sql).not.toContain("default 'now()'")
  })

  it('throws when column type is not allowlisted', () => {
    const T = defineTable(
      pipe(
        object({
          id: pipe(string(), column({ type: 'text' })),
        }),
        title('t'),
        table({ name: 't', primaryKey: 'id' }),
      ),
    )
    const ast = buildCreateTableAst(T, postgresDialect)
    const bad = {
      ...ast,
      columns: [{ ...ast.columns[0]!, dataType: 'evil(); drop table x' }],
    }
    expect(() => postgresDialect.compile(bad)).toThrow(/unsafe|unsupported/)
  })
})
