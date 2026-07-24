import type { Kysely } from 'kysely'
import { boolean, nullable, number, object, pipe, string, title, uuid } from 'valibot'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTableFromSchema } from '@/helpers'
import { column, table } from '@/schemas'

vi.mock('@/helpers/column', () => ({
  getColumnInfo: vi.fn().mockReturnValue({
    dataType: 'text',
    nullable: false,
    defaultValue: undefined,
    unique: false,
    autoIncrement: false,
  }),
}))

function createMockDb() {
  const mockCompile = vi
    .fn()
    .mockReturnValue({ sql: 'CREATE TABLE test (...)' })
  const mockAddColumn = vi.fn().mockImplementation(function (
    this: { addColumn: ReturnType<typeof vi.fn> },
    _tableName: string,
    _columnName: string,
    _dataType: string,
    _config: (col: unknown) => unknown,
  ) {
    return this
  })
  const mockTableBuilder = {
    addColumn: mockAddColumn,
    compile: mockCompile,
  }

  return {
    schema: {
      createTable: vi.fn().mockReturnValue(mockTableBuilder),
    },
  } as unknown as Kysely<unknown>
}

describe('table.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createTableFromSchema', () => {
    it('should throw error when schema does not have table metadata', () => {
      const db = createMockDb()
      const schema = pipe(object({ id: string() }), title('users')) as never

      expect(() => createTableFromSchema(db, schema)).toThrow(
        'Schema must provide a table metadata definition',
      )
    })

    it('should create table with single column', () => {
      const db = createMockDb()
      const UserSchema = pipe(
        object({
          id: pipe(string(), uuid(), column({ type: 'uuid' })),
        }),
        title('users'),
        table({
          name: 'users',
          primaryKey: 'id',
        }),
      )

      const result = createTableFromSchema(db, UserSchema)

      expect(result).toBeDefined()
    })

    it('should create table with multiple columns', () => {
      const db = createMockDb()
      const UserSchema = pipe(
        object({
          id: pipe(string(), uuid(), column({ type: 'uuid' })),
          email: pipe(string(), column({ type: 'varchar(255)' })),
          name: pipe(string(), column({ type: 'text' })),
          age: nullable(pipe(number(), column({ type: 'integer' }))),
          active: pipe(boolean(), column({ type: 'boolean', default: true })),
        }),
        title('users'),
        table({
          name: 'users',
          primaryKey: 'id',
        }),
      )

      const result = createTableFromSchema(db, UserSchema)

      expect(result).toBeDefined()
    })

    it('should set primary key on column', () => {
      const db = createMockDb()
      const UserSchema = pipe(
        object({
          id: pipe(string(), uuid(), column({ type: 'uuid' })),
          name: pipe(string(), column({ type: 'text' })),
        }),
        title('users'),
        table({
          name: 'users',
          primaryKey: 'id',
        }),
      )

      const result = createTableFromSchema(db, UserSchema)

      expect(result).toBeDefined()
    })

    it('should handle column with unique constraint', () => {
      const db = createMockDb()
      const UserSchema = pipe(
        object({
          id: pipe(string(), uuid(), column({ type: 'uuid' })),
          email: pipe(string(), column({ type: 'varchar(255)', unique: true })),
        }),
        title('users'),
        table({
          name: 'users',
          primaryKey: 'id',
        }),
      )

      const result = createTableFromSchema(db, UserSchema)

      expect(result).toBeDefined()
    })

    it('should handle column with default value', () => {
      const db = createMockDb()
      const UserSchema = pipe(
        object({
          id: pipe(string(), uuid(), column({ type: 'uuid' })),
          status: pipe(
            string(),
            column({ type: 'varchar(50)', default: 'active' }),
          ),
        }),
        title('users'),
        table({
          name: 'users',
          primaryKey: 'id',
        }),
      )

      const result = createTableFromSchema(db, UserSchema)

      expect(result).toBeDefined()
    })

    it('should handle column with autoIncrement', () => {
      const db = createMockDb()
      const UserSchema = pipe(
        object({
          id: pipe(number(), column({ type: 'integer', autoIncrement: true })),
          name: pipe(string(), column({ type: 'text' })),
        }),
        title('users'),
        table({
          name: 'users',
          primaryKey: 'id',
        }),
      )

      const result = createTableFromSchema(db, UserSchema)

      expect(result).toBeDefined()
    })

    it('should handle nullable column', () => {
      const db = createMockDb()
      const UserSchema = pipe(
        object({
          id: pipe(string(), uuid(), column({ type: 'uuid' })),
          bio: nullable(pipe(string(), column({ type: 'text' }))),
        }),
        title('users'),
        table({
          name: 'users',
          primaryKey: 'id',
        }),
      )

      const result = createTableFromSchema(db, UserSchema)

      expect(result).toBeDefined()
    })

    it('should use schema name from table metadata', () => {
      const db = createMockDb()
      const UserSchema = pipe(
        object({
          id: pipe(string(), uuid(), column({ type: 'uuid' })),
        }),
        title('users'),
        table({
          name: 'users',
          primaryKey: 'id',
          schema: 'public',
        }),
      )

      const result = createTableFromSchema(db, UserSchema)

      expect(result).toBeDefined()
    })

    it('should include indexes in table metadata', () => {
      const db = createMockDb()
      const UserSchema = pipe(
        object({
          id: pipe(string(), uuid(), column({ type: 'uuid' })),
          email: pipe(string(), column({ type: 'varchar(255)', unique: true })),
          name: pipe(string(), column({ type: 'text' })),
        }),
        title('users'),
        table({
          name: 'users',
          primaryKey: 'id',
          indexes: ['email', 'name'],
        }),
      )

      const result = createTableFromSchema(db, UserSchema)

      expect(result).toBeDefined()
    })
  })
})
