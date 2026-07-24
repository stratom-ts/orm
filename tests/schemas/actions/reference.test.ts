import { object, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, references, getReferenceMetadata, table } from '@/schemas'

describe('references action', () => {
  it('should create reference metadata with table and key from referenced schema', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const ref = references(UserSchema, 'id')

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

    const ref = references(UserSchema, 'id')

    const metadata = getReferenceMetadata(ref)
    expect(metadata).toBeDefined()
    expect(metadata!.dataType).toBe('uuid')
  })

  it('should handle references to tables without explicit column type', () => {
    const UserSchema = pipe(
      object({ id: string() }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )

    const ref = references(UserSchema, 'id')

    const metadata = getReferenceMetadata(ref)
    expect(metadata).toBeDefined()
    expect(metadata!.dataType).toBe('text')
  })
})

describe('getReferenceMetadata', () => {
  it('should return undefined for schema without reference metadata', () => {
    expect(getReferenceMetadata(string())).toBeUndefined()
  })
})
