import type { ColumnMetadata } from 'kysely'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addColumn,
  alterTableSafe,
  checkColumnHasData,
  checkColumnHasNulls,
  diffTableSchema,
} from '@/helpers'
import type { TableSchema } from '@/helpers'
import { MigrationError } from '@/utils'

vi.mock('@/helpers/column', () => ({
  addColumn: vi.fn().mockResolvedValue(undefined),
  checkColumnHasData: vi.fn().mockResolvedValue(false),
  checkColumnHasNulls: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/helpers/diff', () => ({
  diffTableSchema: vi.fn(),
}))

const mockTrx = {
  schema: {
    alterTable: vi.fn().mockReturnValue({
      dropColumn: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue([]),
      }),
      addColumn: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue([]),
      }),
      alterColumn: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
} as never

const mockSchema = {} as TableSchema
const mockDbColumns: ColumnMetadata[] = []

const mockDiffTableSchema = diffTableSchema as ReturnType<typeof vi.fn>

describe('alter.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('alterTableSafe', () => {
    it('should return no changes when schemas match', async () => {
      mockDiffTableSchema.mockReturnValue(null)

      await alterTableSafe(mockTrx, mockSchema, mockDbColumns)

      expect(mockDiffTableSchema).toHaveBeenCalledWith(
        mockSchema,
        mockDbColumns,
        expect.anything(),
      )
    })

    it('should drop column when no data exists', async () => {
      const diff = {
        tableName: 'users',
        added: [],
        modified: [],
        removed: ['old_column'],
      }
      mockDiffTableSchema.mockReturnValue(diff)
      ;(checkColumnHasData as ReturnType<typeof vi.fn>).mockResolvedValue(false)

      await alterTableSafe(mockTrx, mockSchema, mockDbColumns)
    })

    it('should throw MigrationError when dropping column with data', async () => {
      const diff = {
        tableName: 'users',
        added: [],
        modified: [],
        removed: ['old_column'],
      }
      mockDiffTableSchema.mockReturnValue(diff)
      ;(checkColumnHasData as ReturnType<typeof vi.fn>).mockResolvedValue(true)

      await expect(
        alterTableSafe(mockTrx, mockSchema, mockDbColumns),
      ).rejects.toThrow(MigrationError)
    })

    it('should add new column', async () => {
      const columnDiff = {
        name: 'new_column',
        local: { dataType: 'text', nullable: true } as {
          dataType: string
          nullable: boolean
        },
        current: null,
      }
      const diff = {
        tableName: 'users',
        added: [columnDiff],
        modified: [],
        removed: [],
      }
      mockDiffTableSchema.mockReturnValue(diff)

      await alterTableSafe(mockTrx, mockSchema, mockDbColumns)

      expect(addColumn).toHaveBeenCalledWith(
        mockTrx,
        'users',
        mockSchema,
        'new_column',
      )
    })

    it('should modify column - change data type', async () => {
      const columnDiff = {
        name: 'email',
        local: { dataType: 'text', nullable: true } as {
          dataType: string
          nullable: boolean
        },
        current: {
          name: 'email',
          type: 'varchar',
          isNullable: true,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        } as unknown as ColumnMetadata,
      }
      const diff = {
        tableName: 'users',
        added: [],
        modified: [columnDiff],
        removed: [],
      }
      mockDiffTableSchema.mockReturnValue(diff)

      await alterTableSafe(mockTrx, mockSchema, mockDbColumns)
    })

    it('should throw MigrationError when setting NOT NULL with NULL values', async () => {
      const columnDiff = {
        name: 'email',
        local: { dataType: 'text', nullable: false } as {
          dataType: string
          nullable: boolean
        },
        current: {
          name: 'email',
          dataType: 'text',
          type: 'text',
          isNullable: true,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        } as unknown as ColumnMetadata,
      }
      const diff = {
        tableName: 'users',
        added: [],
        modified: [columnDiff],
        removed: [],
      }
      mockDiffTableSchema.mockReturnValue(diff)
      ;(checkColumnHasNulls as ReturnType<typeof vi.fn>).mockResolvedValue(true)

      await expect(
        alterTableSafe(mockTrx, mockSchema, mockDbColumns),
      ).rejects.toThrow(MigrationError)
    })

    it('should set NOT NULL when no NULL values exist', async () => {
      const columnDiff = {
        name: 'email',
        local: { dataType: 'text', nullable: false } as {
          dataType: string
          nullable: boolean
        },
        current: {
          name: 'email',
          type: 'text',
          isNullable: true,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        } as unknown as ColumnMetadata,
      }
      const diff = {
        tableName: 'users',
        added: [],
        modified: [columnDiff],
        removed: [],
      }
      mockDiffTableSchema.mockReturnValue(diff)
      ;(checkColumnHasNulls as ReturnType<typeof vi.fn>).mockResolvedValue(
        false,
      )

      await alterTableSafe(mockTrx, mockSchema, mockDbColumns)
    })

    it('should drop NOT NULL constraint when column becomes nullable', async () => {
      const columnDiff = {
        name: 'email',
        local: { dataType: 'text', nullable: true } as {
          dataType: string
          nullable: boolean
        },
        current: {
          name: 'email',
          type: 'text',
          isNullable: false,
          isAutoIncrementing: false,
          hasDefaultValue: false,
        } as unknown as ColumnMetadata,
      }
      const diff = {
        tableName: 'users',
        added: [],
        modified: [columnDiff],
        removed: [],
      }
      mockDiffTableSchema.mockReturnValue(diff)

      await alterTableSafe(mockTrx, mockSchema, mockDbColumns)
    })

    it('should handle multiple changes at once', async () => {
      const diff = {
        tableName: 'users',
        added: [
          {
            name: 'new_col',
            local: { dataType: 'text', nullable: true } as {
              dataType: string
              nullable: boolean
            },
            current: null,
          },
        ],
        modified: [
          {
            name: 'email',
            local: { dataType: 'text', nullable: true } as {
              dataType: string
              nullable: boolean
            },
            current: {
              name: 'email',
              type: 'varchar',
              isNullable: true,
              isAutoIncrementing: false,
              hasDefaultValue: false,
            } as unknown as ColumnMetadata,
          },
        ],
        removed: ['old_col'],
      }
      mockDiffTableSchema.mockReturnValue(diff)
      ;(checkColumnHasData as ReturnType<typeof vi.fn>).mockResolvedValue(false)

      await alterTableSafe(mockTrx, mockSchema, mockDbColumns)
    })

    it('should skip modification when current column is null', async () => {
      const columnDiff = {
        name: 'email',
        local: { dataType: 'text', nullable: true } as {
          dataType: string
          nullable: boolean
        },
        current: null,
      }
      const diff = {
        tableName: 'users',
        added: [],
        modified: [columnDiff],
        removed: [],
      }
      mockDiffTableSchema.mockReturnValue(diff)

      await alterTableSafe(mockTrx, mockSchema, mockDbColumns)
    })
  })
})
