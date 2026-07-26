import { object, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import { getTableMetadata, table } from '@/index'

describe('table action', () => {
  it('should create table metadata action with correct kind', () => {
    const action = table({ name: 'users', primaryKey: 'id' })
    expect(action.type).toBe('metadata')

    const metadata = action.metadata as Record<string, unknown>
    expect(metadata.kind).toBe('table')
    expect(metadata.name).toBe('users')
    expect(metadata.primaryKey).toBe('id')
  })

  it('should create table with optional fields', () => {
    const action = table({
      name: 'posts',
      primaryKey: 'id',
      indexes: ['title', 'created_at'],
      schema: 'public',
    })

    const metadata = action.metadata as Record<string, unknown>
    expect(metadata).toMatchObject({
      kind: 'table',
      name: 'posts',
      primaryKey: 'id',
      indexes: ['title', 'created_at'],
      schema: 'public',
    })
  })

  it('should create table without optional fields', () => {
    const action = table({ name: 'tags', primaryKey: 'id' })

    const metadata = action.metadata as Record<string, unknown>
    expect(metadata.indexes).toBeUndefined()
    expect(metadata.schema).toBeUndefined()
  })

  it('should accept composite primary keys and index configs', () => {
    const action = table({
      name: 'memberships',
      primaryKey: ['orgId', 'userId'],
      indexes: [
        { name: 'memberships_role_idx', columns: ['role'] },
        { columns: ['orgId', 'role'], unique: true },
      ],
      schema: 'app',
    })

    const metadata = action.metadata as Record<string, unknown>
    expect(metadata).toMatchObject({
      kind: 'table',
      name: 'memberships',
      primaryKey: ['orgId', 'userId'],
      schema: 'app',
      indexes: [
        { name: 'memberships_role_idx', columns: ['role'] },
        { columns: ['orgId', 'role'], unique: true },
      ],
    })
  })
})

describe('getTableMetadata', () => {
  it('should return undefined for schema without table metadata', () => {
    const schema = pipe(string(), title('test'))
    expect(getTableMetadata(schema)).toBeUndefined()
  })

  it('should extract table metadata from schema', () => {
    const schema = pipe(
      object({ id: string() }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const metadata = getTableMetadata(schema)
    expect(metadata).toBeDefined()
    expect(metadata!.name).toBe('users')
    expect(metadata!.primaryKey).toBe('id')
  })

  it('should return undefined for a plain string schema', () => {
    expect(getTableMetadata(string())).toBeUndefined()
  })
})
