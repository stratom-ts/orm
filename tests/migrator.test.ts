import { object, pipe, string, title } from 'valibot'
import type { Kysely, TableMetadata } from 'kysely'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { column, table } from '@/schemas'
import { alterTableSafe, createIndexes, createTableFromSchema } from '@/helpers'
import { runMigrations } from '@/migrator'

vi.mock('@/helpers/alter', () => ({
  alterTableSafe: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/helpers/index', () => ({
  alterTableSafe: vi.fn().mockResolvedValue(undefined),
  createIndexes: vi.fn().mockReturnValue([]),
  createTableFromSchema: vi
    .fn()
    .mockReturnValue({ sql: 'CREATE TABLE ...', parameters: [] }),
}))

const UserSchema = pipe(
  object({ id: pipe(string(), column({ type: 'uuid' })) }),
  title('users'),
  table({ name: 'users', primaryKey: 'id' }),
)

const PostSchema = pipe(
  object({ id: pipe(string(), column({ type: 'uuid' })) }),
  title('posts'),
  table({ name: 'posts', primaryKey: 'id' }),
)

const mockDb = {
  introspection: {
    getTables: vi.fn(),
  },
  transaction: vi.fn().mockReturnValue({
    execute: vi
      .fn()
      .mockImplementation(async (cb: (trx: unknown) => Promise<void>) => {
        await cb(mockTrx)
      }),
  }),
} as never as Kysely<never>

const mockTrx = {
  executeQuery: vi.fn().mockResolvedValue([]),
} as never

describe('runMigrations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should create a new table if it does not exist', async () => {
    ;(
      mockDb.introspection.getTables as ReturnType<typeof vi.fn>
    ).mockResolvedValue([])

    await runMigrations(mockDb, [UserSchema])

    expect(createTableFromSchema).toHaveBeenCalled()
    expect(alterTableSafe).not.toHaveBeenCalled()
  })

  it('should alter an existing table', async () => {
    const existingTables = [{ name: 'users' }] as TableMetadata[]
    ;(
      mockDb.introspection.getTables as ReturnType<typeof vi.fn>
    ).mockResolvedValue(existingTables)

    await runMigrations(mockDb, [UserSchema])

    expect(alterTableSafe).toHaveBeenCalled()
    expect(createTableFromSchema).not.toHaveBeenCalled()
  })

  it('should create indexes after altering a table', async () => {
    const existingTables = [{ name: 'users' }] as TableMetadata[]
    ;(
      mockDb.introspection.getTables as ReturnType<typeof vi.fn>
    ).mockResolvedValue(existingTables)

    await runMigrations(mockDb, [UserSchema])

    expect(createIndexes).toHaveBeenCalled()
  })

  it('should process multiple schemas', async () => {
    ;(
      mockDb.introspection.getTables as ReturnType<typeof vi.fn>
    ).mockResolvedValue([])

    await runMigrations(mockDb, [UserSchema, PostSchema])

    expect(createTableFromSchema).toHaveBeenCalledTimes(2)
  })

  it('should handle empty schema array', async () => {
    ;(
      mockDb.introspection.getTables as ReturnType<typeof vi.fn>
    ).mockResolvedValue([])

    await runMigrations(mockDb, [])

    expect(createTableFromSchema).not.toHaveBeenCalled()
    expect(alterTableSafe).not.toHaveBeenCalled()
  })
})
