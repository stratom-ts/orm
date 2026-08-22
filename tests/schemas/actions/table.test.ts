import { object, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import { SchemaError, getTableMetadata, table } from '@/index'

export const relationOptionTypeCoverage = () => {
  // @ts-expect-error schema and namespace are mutually exclusive
  table({
    name: 'events',
    primaryKey: 'id',
    schema: 'app',
    namespace: [{ role: 'schema', spelling: 'app' }] as const,
  })
}

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
      indexes: [{ columns: ['title'] }, { columns: ['created_at'] }],
      schema: 'public',
    })

    const metadata = action.metadata as Record<string, unknown>
    expect(metadata).toMatchObject({
      kind: 'table',
      name: 'posts',
      primaryKey: 'id',
      indexes: [{ columns: ['title'] }, { columns: ['created_at'] }],
      schema: 'public',
    })
  })

  it('should create table without optional fields', () => {
    const action = table({ name: 'tags', primaryKey: 'id' })

    const metadata = action.metadata as Record<string, unknown>
    expect(metadata.indexes).toBeUndefined()
    expect(metadata.schema).toBeUndefined()
    expect(metadata.relation).toEqual({ relation: 'tags' })
  })

  it('retains ordered portable namespace intent', () => {
    const action = table({
      name: 'events',
      primaryKey: 'id',
      namespace: [
        { role: 'catalog', spelling: 'app' },
        { role: 'database', spelling: 'tenant' },
        { role: 'schema', spelling: 'audit' },
      ],
    })

    expect((action.metadata as Record<string, unknown>).relation).toEqual({
      namespace: [
        { role: 'catalog', spelling: 'app' },
        { role: 'database', spelling: 'tenant' },
        { role: 'schema', spelling: 'audit' },
      ],
      relation: 'events',
    })
  })

  it('treats an empty namespace as omitted/default intent', () => {
    const action = table({
      name: 'events',
      primaryKey: 'id',
      namespace: [],
    })

    expect((action.metadata as Record<string, unknown>).relation).toEqual({
      relation: 'events',
    })
  })

  it('rejects conflicting and malformed namespace intent', () => {
    expect(() =>
      table({
        name: 'events',
        primaryKey: 'id',
        schema: 'app',
        namespace: [{ role: 'schema', spelling: 'app' }],
      } as never),
    ).toThrow(SchemaError)
    expect(() =>
      table({
        name: 'events',
        primaryKey: 'id',
        namespace: [
          { role: 'schema', spelling: 'app' },
          { role: 'schema', spelling: 'other' },
        ],
      } as never),
    ).toThrow(/duplicate namespace role/)
    expect(() =>
      table({
        name: 'events',
        primaryKey: 'id',
        namespace: [{ role: 'schema', spelling: '' }],
      } as never),
    ).toThrow(/non-empty/)
    expect(() =>
      table({
        name: 'events',
        primaryKey: 'id',
        namespace: 'app' as never,
      } as never),
    ).toThrow(SchemaError)
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
