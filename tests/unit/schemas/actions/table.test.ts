import { metadata, nullable, object, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import { SchemaError, getTableMetadata, isTableMetadata, table } from '@/index'

export const relationOptionTypeCoverage = () => {
  table({
    name: 'events',
    primaryKey: 'id',
    // @ts-expect-error PostgreSQL schema shorthand is not portable table intent
    schema: 'app',
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
      namespace: [{ role: 'schema', spelling: 'public' }],
    })

    const metadata = action.metadata as Record<string, unknown>
    expect(metadata).toMatchObject({
      kind: 'table',
      name: 'posts',
      primaryKey: 'id',
      indexes: [{ columns: ['title'] }, { columns: ['created_at'] }],
      relation: {
        namespace: [{ role: 'schema', spelling: 'public' }],
        relation: 'posts',
      },
    })
    expect(metadata).not.toHaveProperty('schema')
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

  it('copies the authored namespace list so later list edits cannot retarget a table', () => {
    const namespace = [{ role: 'schema' as const, spelling: 'audit' }]
    const action = table({ name: 'events', primaryKey: 'id', namespace })

    namespace.push({ role: 'schema', spelling: 'other' })

    expect((action.metadata as Record<string, unknown>).relation).toEqual({
      namespace: [{ role: 'schema', spelling: 'audit' }],
      relation: 'events',
    })
  })

  it.fails('copies namespace segments so later spelling edits cannot retarget a table', () => {
    const segment = { role: 'schema' as const, spelling: 'audit' }
    const action = table({ name: 'events', primaryKey: 'id', namespace: [segment] })

    segment.spelling = 'other'

    expect((action.metadata as Record<string, unknown>).relation).toEqual({
      namespace: [{ role: 'schema', spelling: 'audit' }],
      relation: 'events',
    })
  })

  it('preserves namespace role, order, and spelling as distinct authored intent', () => {
    const schemaThenDatabase = table({
      name: 'events',
      primaryKey: 'id',
      namespace: [
        { role: 'schema', spelling: 'Audit' },
        { role: 'database', spelling: 'tenant' },
      ],
    })
    const databaseThenSchema = table({
      name: 'events',
      primaryKey: 'id',
      namespace: [
        { role: 'database', spelling: 'tenant' },
        { role: 'schema', spelling: 'audit' },
      ],
    })

    expect(schemaThenDatabase.metadata.relation).not.toEqual(
      databaseThenSchema.metadata.relation,
    )
    expect(schemaThenDatabase.metadata.relation.namespace).toEqual([
      { role: 'schema', spelling: 'Audit' },
      { role: 'database', spelling: 'tenant' },
    ])
  })

  it('rejects malformed namespace intent', () => {
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
    expect(() =>
      table({
        name: 'events',
        primaryKey: 'id',
        namespace: [null],
      } as never),
    ).toThrow(/segments must be objects/i)
    expect(() =>
      table({
        name: 'events',
        primaryKey: 'id',
        namespace: [{ role: 'tenant', spelling: 'app' }],
      } as never),
    ).toThrow(/unsupported namespace role tenant/i)
  })

  it('should accept composite primary keys and index configs', () => {
    const action = table({
      name: 'memberships',
      primaryKey: ['orgId', 'userId'],
      indexes: [
        { name: 'memberships_role_idx', columns: ['role'] },
        { columns: ['orgId', 'role'], unique: true },
      ],
      namespace: [{ role: 'schema', spelling: 'app' }],
    })

    const metadata = action.metadata as Record<string, unknown>
    expect(metadata).toMatchObject({
      kind: 'table',
      name: 'memberships',
      primaryKey: ['orgId', 'userId'],
      relation: {
        namespace: [{ role: 'schema', spelling: 'app' }],
        relation: 'memberships',
      },
      indexes: [
        { name: 'memberships_role_idx', columns: ['role'] },
        { columns: ['orgId', 'role'], unique: true },
      ],
    })
    expect(metadata).not.toHaveProperty('schema')
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

  it('does not confuse non-table or malformed metadata for table metadata', () => {
    expect(
      getTableMetadata(pipe(object({ id: string() }), metadata({ kind: 'column' }))),
    ).toBeUndefined()
    expect(
      getTableMetadata(pipe(object({ id: string() }), metadata({ kind: 7 }))),
    ).toBeUndefined()
  })

  it('has a stable unsupported result for a table schema hidden by a wrapper', () => {
    const schema = nullable(
      pipe(
        object({ id: string() }),
        title('accounts'),
        table({ name: 'accounts', primaryKey: 'id' }),
      ),
    )

    expect(getTableMetadata(schema)).toBeUndefined()
  })
})

describe('isTableMetadata', () => {
  it('matches only the table discriminant for public metadata inspection', () => {
    expect(isTableMetadata({ kind: 'table', name: 'accounts' })).toBe(true)
    expect(isTableMetadata({ kind: 'column', name: 'accounts' })).toBe(false)
    expect(isTableMetadata({ name: 'accounts', primaryKey: 'id' })).toBe(false)
    expect(isTableMetadata(undefined)).toBe(false)
  })
})
