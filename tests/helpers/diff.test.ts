import type { ColumnMetadata as DbColumnMetadata } from 'kysely'
import { boolean, object, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import { diffTableSchema } from '@/helpers'
import { column, table } from '@/schemas'

const validSchema = pipe(
  object({
    id: pipe(string(), column({ type: 'varchar' })),
    name: pipe(string(), column({ type: 'varchar', nullable: true })),
  }),
  title('test_table'),
  table({ name: 'test_table', primaryKey: 'id' }),
)

const invalidSchema = pipe(
  object({ id: string() }),
  title('test_table'),
) as never

const dbColumnBase = {
  isNullable: false,
  isAutoIncrementing: false,
  hasDefaultValue: false,
}

describe('diff.ts', () => {
  describe('diffTableSchema', () => {
    it('should return null when schemas match', () => {
      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'id',
          dataType: 'varchar',
          isNullable: false,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        },
        {
          name: 'name',
          dataType: 'varchar',
          isNullable: true,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        },
      ]

      const result = diffTableSchema(validSchema, dbColumns)
      expect(result).toBeNull()
    })

    it('should return null when no metadata is provided', () => {
      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'id',
          dataType: 'varchar',
          isNullable: false,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        },
      ]

      const result = diffTableSchema(invalidSchema, dbColumns)
      expect(result).toBeNull()
    })

    it('should detect added columns', () => {
      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'id',
          dataType: 'varchar',
          ...dbColumnBase,
        },
      ]

      const result = diffTableSchema(validSchema, dbColumns)

      expect(result).not.toBeNull()
      const r = result!
      expect(r.added).toHaveLength(1)
      const addedCol = r.added[0]!
      expect(addedCol.name).toBe('name')
      expect(addedCol.local.nullable).toBe(true)
    })

    it('should detect removed columns', () => {
      const schemaWithExtraColumn = pipe(
        object({
          id: pipe(string(), column({ type: 'varchar' })),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'id',
          dataType: 'varchar',
          ...dbColumnBase,
        },
        {
          name: 'removed_col',
          dataType: 'text',
          ...dbColumnBase,
        },
      ]

      const result = diffTableSchema(schemaWithExtraColumn, dbColumns)

      expect(result).not.toBeNull()
      const r = result!
      expect(r.removed).toHaveLength(1)
      expect(r.removed[0]).toBe('removed_col')
    })

    it('should detect modified dataType', () => {
      const schemaWithText = pipe(
        object({
          id: pipe(string(), column({ type: 'text' })),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'id',
          dataType: 'varchar',
          ...dbColumnBase,
        },
      ]

      const result = diffTableSchema(schemaWithText, dbColumns)

      expect(result).not.toBeNull()
      const r = result!
      expect(r.modified).toHaveLength(1)
      const modifiedCol = r.modified[0]!
      expect(modifiedCol.name).toBe('id')
      expect(modifiedCol.local.dataType).toBe('text')
    })

    it('should detect modified nullable from true to false', () => {
      const schemaNotNullable = pipe(
        object({
          id: pipe(string(), column({ type: 'varchar', nullable: false })),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'id',
          dataType: 'varchar',
          isNullable: true,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        },
      ]

      const result = diffTableSchema(schemaNotNullable, dbColumns)

      expect(result).not.toBeNull()
      const r = result!
      expect(r.modified).toHaveLength(1)
      const modifiedCol = r.modified[0]!
      expect(modifiedCol.local.nullable).toBe(false)
    })

    it('should detect modified nullable from false to true', () => {
      const schemaNullable = pipe(
        object({
          id: pipe(string(), column({ type: 'varchar', nullable: true })),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'id',
          dataType: 'varchar',
          isNullable: false,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        },
      ]

      const result = diffTableSchema(schemaNullable, dbColumns)

      expect(result).not.toBeNull()
      const r = result!
      expect(r.modified).toHaveLength(1)
      const modifiedCol = r.modified[0]!
      expect(modifiedCol.local.nullable).toBe(true)
    })

    it('should detect modified autoIncrement', () => {
      const schemaWithAutoIncrement = pipe(
        object({
          id: pipe(string(), column({ type: 'varchar', autoIncrement: true })),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'id',
          dataType: 'varchar',
          isNullable: false,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        },
      ]

      const result = diffTableSchema(schemaWithAutoIncrement, dbColumns)

      expect(result).not.toBeNull()
      const r = result!
      expect(r.modified).toHaveLength(1)
      const modifiedCol = r.modified[0]!
      expect(modifiedCol.local.autoIncrement).toBe(true)
    })

    it('should detect modified defaultValue', () => {
      const schemaWithDefault = pipe(
        object({
          status: pipe(
            string(),
            column({ type: 'varchar', default: 'active' }),
          ),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'status',
          dataType: 'varchar',
          isNullable: true,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        },
      ]

      const result = diffTableSchema(schemaWithDefault, dbColumns)

      expect(result).not.toBeNull()
      const r = result!
      expect(r.modified).toHaveLength(1)
      const modifiedCol = r.modified[0]!
      expect(modifiedCol.local.default).toBe('active')
    })

    it('should normalize PostgreSQL data types - int4 to integer', () => {
      const schemaWithInt = pipe(
        object({
          count: pipe(string(), column({ type: 'integer' })),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'count',
          dataType: 'int4',
          ...dbColumnBase,
        },
      ]

      const result = diffTableSchema(schemaWithInt, dbColumns)

      expect(result).toBeNull()
    })

    it('should normalize PostgreSQL data types - bool to boolean', () => {
      const schemaWithBoolean = pipe(
        object({
          active: pipe(boolean(), column({ type: 'boolean' })),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'active',
          dataType: 'bool',
          ...dbColumnBase,
        },
      ]

      const result = diffTableSchema(schemaWithBoolean, dbColumns)

      expect(result).toBeNull()
    })

    it('should normalize PostgreSQL data types - timestamptz', () => {
      const schemaWithTimestamp = pipe(
        object({
          createdAt: pipe(string(), column({ type: 'timestamptz' })),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'createdAt',
          dataType: 'timestamptz',
          ...dbColumnBase,
        },
      ]

      const result = diffTableSchema(schemaWithTimestamp, dbColumns)

      expect(result).toBeNull()
    })

    it('should detect multiple changes at once', () => {
      const schemaWithChanges = pipe(
        object({
          id: pipe(string(), column({ type: 'varchar', autoIncrement: true })),
          newColumn: pipe(string(), column({ type: 'text' })),
        }),
        title('test_table'),
        table({ name: 'test_table', primaryKey: 'id' }),
      )

      const dbColumns: DbColumnMetadata[] = [
        {
          name: 'id',
          dataType: 'varchar',
          isNullable: false,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        },
        {
          name: 'oldColumn',
          dataType: 'text',
          ...dbColumnBase,
        },
      ]

      const result = diffTableSchema(schemaWithChanges, dbColumns)

      expect(result).not.toBeNull()
      const r = result!
      expect(r.added).toHaveLength(1)
      const addedCol = r.added[0]!
      expect(addedCol.name).toBe('newColumn')
      expect(r.modified).toHaveLength(1)
      const modifiedCol = r.modified[0]!
      expect(modifiedCol.name).toBe('id')
      expect(r.removed).toHaveLength(1)
      const removedCol = r.removed[0]!
      expect(removedCol).toBe('oldColumn')
    })

    it('should return tableName in result', () => {
      const dbColumns: DbColumnMetadata[] = []

      const result = diffTableSchema(validSchema, dbColumns)

      expect(result).not.toBeNull()
      const r = result!
      expect(r.tableName).toBe('test_table')
    })
  })
})
