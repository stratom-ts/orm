import { object, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, reference, getReferenceMetadata, table } from '@/schemas'

describe('reference action', () => {
  it('should create reference metadata with table and key from referenced schema', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const ref = reference(UserSchema, 'id')

    const metadata = getReferenceMetadata(ref)
    expect(metadata).toBeDefined()
    expect(metadata!.kind).toBe('reference')
    expect(metadata!.table).toBe('users')
    expect(metadata!.key).toBe('id')
  })

  it('should infer data type from referenced column metadata', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const ref = reference(UserSchema, 'id')

    const metadata = getReferenceMetadata(ref)
    expect(metadata).toBeDefined()
    expect(metadata!.dataType).toBe('uuid')
  })

  it('should handle reference to table without explicit column type', () => {
    const UserSchema = pipe(
      object({ id: string() }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const ref = reference(UserSchema, 'id')

    const metadata = getReferenceMetadata(ref)
    expect(metadata).toBeDefined()
    expect(metadata!.dataType).toBe('text')
  })

  it('should attach onDelete and onUpdate options', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
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
      table: 'users',
      key: 'id',
      onDelete: 'cascade',
      onUpdate: 'set null',
    })
  })
})

describe('getReferenceMetadata', () => {
  it('should return undefined for schema without reference metadata', () => {
    expect(getReferenceMetadata(string())).toBeUndefined()
  })
})
