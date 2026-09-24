import { metadata, nullable, object, optional, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import {
  column,
  defineTable,
  getColumnMetadata,
  getReferenceMetadata,
  getTableMetadata,
  isReferenceMetadata,
  reference,
  table,
} from '@/index'

describe('reference action', () => {
  it('copies complete structured relation intent from raw schemas and handles', () => {
    const namespace = [
      { role: 'catalog' as const, spelling: 'app' },
      { role: 'database' as const, spelling: 'tenant' },
      { role: 'schema' as const, spelling: 'audit' },
    ]
    const TargetSchema = pipe(
      object({ id: string() }),
      title('events'),
      table({ name: 'events', primaryKey: 'id', namespace }),
    )
    const TargetHandle = defineTable(
      'events',
      { id: string() },
      { primaryKey: 'id', namespace },
    )

    expect(getReferenceMetadata(reference(TargetSchema, 'id'))?.target.relation).toBe(
      getTableMetadata(TargetSchema)!.relation,
    )

    expect(getReferenceMetadata(reference(TargetHandle, 'id'))?.target.relation).toBe(
      TargetHandle.getTableMetadata().relation,
    )
  })

  it('copies namespace segment spelling from a raw schema', () => {
    const rawSegment = { role: 'schema' as const, spelling: 'raw_audit' }
    const RawTarget = pipe(
      object({ id: string() }),
      title('raw_events'),
      table({ name: 'raw_events', primaryKey: 'id', namespace: [rawSegment] }),
    )
    const rawReference = reference(RawTarget, 'id')
    rawSegment.spelling = 'raw_other'

    expect(getReferenceMetadata(rawReference)?.target.relation).toEqual({
      namespace: [{ role: 'schema', spelling: 'raw_audit' }],
      relation: 'raw_events',
    })
  })

  it('copies namespace segment spelling from a table handle', () => {
    const handleSegment = { role: 'schema' as const, spelling: 'handle_audit' }
    const HandleTarget = defineTable(
      'handle_events',
      { id: string() },
      { primaryKey: 'id', namespace: [handleSegment] },
    )

    const handleReference = reference(HandleTarget, 'id')
    handleSegment.spelling = 'handle_other'

    expect(getReferenceMetadata(handleReference)?.target.relation).toEqual({
      namespace: [{ role: 'schema', spelling: 'handle_audit' }],
      relation: 'handle_events',
    })
  })

  it('should create only structured target metadata from referenced schema', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const ref = reference(UserSchema, 'id')

    const metadata = getReferenceMetadata(ref)
    expect(metadata).toBeDefined()
    expect(metadata!.kind).toBe('reference')

    expect(metadata!.target).toEqual({
      relation: { relation: 'users' },
      column: 'id',
    })

    expect(metadata).not.toHaveProperty('table')
    expect(metadata).not.toHaveProperty('key')
  })

  it('should retain a structured target without copying a physical type', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const ref = reference(UserSchema, 'id')

    const metadata = getReferenceMetadata(ref)
    expect(metadata).toBeDefined()

    expect(metadata).toMatchObject({
      target: { relation: { relation: 'users' }, column: 'id' },
    })

    expect(metadata).not.toHaveProperty('dataType')
  })

  it('should not eagerly infer a type for an untyped target', () => {
    const UserSchema = pipe(
      object({ id: string() }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const ref = reference(UserSchema, 'id')

    const metadata = getReferenceMetadata(ref)
    expect(metadata).toBeDefined()
    expect(metadata).not.toHaveProperty('dataType')
  })

  it('should attach onDelete and onUpdate options', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const ref = reference(UserSchema, 'id', {
      onDelete: 'cascade',
      onUpdate: 'set null',
    })

    const metadata = getReferenceMetadata(ref)
    expect(metadata).toMatchObject({
      kind: 'reference',
      target: { relation: { relation: 'users' }, column: 'id' },
      onDelete: 'cascade',
      onUpdate: 'set null',
    })
  })

  it('should retain local column and nested reference metadata together', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )
    const composed = pipe(reference(UserSchema, 'id'), column({ unique: true }))

    expect(getColumnMetadata(composed)).toMatchObject({ kind: 'column', unique: true })

    expect(getReferenceMetadata(composed)).toMatchObject({
      kind: 'reference',
      target: { relation: { relation: 'users' }, column: 'id' },
    })
  })

  it('should retain both metadata kinds through nullable wrappers', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )
    const composed = nullable(
      pipe(
        reference(UserSchema, 'id'),
        column({ databaseDefault: { kind: 'literal', value: null } }),
      ),
    )

    expect(getColumnMetadata(composed)).toMatchObject({
      kind: 'column',
      databaseDefault: { kind: 'literal', value: null },
    })

    expect(getReferenceMetadata(composed)).toMatchObject({
      kind: 'reference',
      target: { relation: { relation: 'users' }, column: 'id' },
    })
  })
})

describe('getReferenceMetadata', () => {
  it('should return undefined for schema without reference metadata', () => {
    expect(getReferenceMetadata(string())).toBeUndefined()
  })

  it('does not confuse column metadata for a reference', () => {
    expect(
      getReferenceMetadata(
        pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      ),
    ).toBeUndefined()
  })

  it('finds the nearest reference through nested pipes and wrappers', () => {
    const Accounts = defineTable('accounts', { id: string() }, { primaryKey: 'id' })
    const schema = nullable(
      optional(pipe(reference(Accounts, 'id'), metadata({ note: true }))),
    )

    expect(getReferenceMetadata(schema)).toEqual({
      kind: 'reference',
      target: { relation: { relation: 'accounts' }, column: 'id' },
    })
  })

  it('ignores malformed metadata actions instead of treating them as references', () => {
    const schema = pipe(string(), metadata({ kind: null, target: 'accounts.id' }))

    expect(getReferenceMetadata(schema)).toBeUndefined()
  })
})

describe('isReferenceMetadata', () => {
  it('matches only the reference discriminant for public metadata inspection', () => {
    expect(
      isReferenceMetadata({
        kind: 'reference',
        target: { relation: { relation: 'accounts' }, column: 'id' },
      }),
    ).toBe(true)

    expect(isReferenceMetadata({ kind: 'column' })).toBe(false)

    expect(isReferenceMetadata({ target: { relation: 'accounts', column: 'id' } })).toBe(
      false,
    )

    expect(isReferenceMetadata(undefined)).toBe(false)
  })
})
