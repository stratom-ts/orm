import { nullable, object, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import {
  column,
  getColumnMetadata,
  getReferenceMetadata,
  reference,
  table,
} from '@/index'

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

  it('should retain a structured target without copying a physical type', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
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

  it('should retain local column and nested reference metadata together', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
      title('users'),
      table({ name: 'users', primaryKey: 'id' }),
    )
    const composed = pipe(reference(UserSchema, 'id'), column({ unique: true }))

    expect(getColumnMetadata(composed)).toMatchObject({ kind: 'column', unique: true })
    expect(getReferenceMetadata(composed)).toMatchObject({
      kind: 'reference',
      table: 'users',
      key: 'id',
    })
  })

  it('should retain both metadata kinds through nullable wrappers', () => {
    const UserSchema = pipe(
      object({ id: pipe(string(), column({ type: 'uuid' })) }),
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
      table: 'users',
      key: 'id',
    })
  })
})

describe('getReferenceMetadata', () => {
  it('should return undefined for schema without reference metadata', () => {
    expect(getReferenceMetadata(string())).toBeUndefined()
  })
})
