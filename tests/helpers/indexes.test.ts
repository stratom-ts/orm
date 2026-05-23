import type { Kysely } from 'kysely'
import { describe, expect, it, vi } from 'vitest'

import { createIndexes } from '@helpers/indexes'

function createMockDb() {
  const mockCompile = vi.fn()
  const mockBuilder = {
    ifNotExists: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    column: vi.fn().mockReturnThis(),
    compile: mockCompile,
  }
  const mockCreateIndex = vi.fn().mockReturnValue(mockBuilder)

  return {
    schema: { createIndex: mockCreateIndex },
  } as unknown as Kysely<unknown>
}

describe('indexes.ts', () => {
  describe('createIndexes', () => {
    it('should return empty array when no indexes provided', () => {
      const db = createMockDb()
      const result = createIndexes(db, 'users')
      expect(result).toEqual([])
    })

    it('should return empty array when empty indexes array provided', () => {
      const db = createMockDb()
      const result = createIndexes(db, 'users', [])
      expect(result).toEqual([])
    })

    it('should create index queries for each column', () => {
      const db = createMockDb()

      createIndexes(db, 'users', ['email', 'created_at'])

      expect(db.schema.createIndex).toHaveBeenCalledWith('users_email_idx')
      expect(db.schema.createIndex).toHaveBeenCalledWith('users_created_at_idx')
    })

    it('should include IF NOT EXISTS clause', () => {
      const db = createMockDb()
      createIndexes(db, 'users', ['email'])

      expect(db.schema.createIndex).toHaveBeenCalledWith('users_email_idx')
    })

    it('should use correct table name', () => {
      const db = createMockDb()
      createIndexes(db, 'custom_table', ['column1'])
      expect(db.schema.createIndex).toHaveBeenCalledWith(
        'custom_table_column1_idx',
      )
    })

    it('should handle single column index', () => {
      const db = createMockDb()
      const result = createIndexes(db, 'users', ['email'])
      expect(result).toHaveLength(1)
    })
  })
})
