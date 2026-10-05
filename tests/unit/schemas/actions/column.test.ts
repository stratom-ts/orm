import { metadata, nullable, optional, pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, getColumnMetadata, isColumnMetadata } from '@/index'

describe('column action', () => {
  it('should create column metadata action with correct kind', () => {
    const action = column({ physicalType: { postgresql: 'varchar' } })
    expect(action.type).toBe('metadata')
    const metadata = action.metadata as Record<string, unknown>
    expect(metadata.kind).toBe('column')
    expect(metadata.physicalType).toEqual({ postgresql: 'varchar' })
  })

  it('should create column with all options', () => {
    const action = column({
      physicalType: { postgresql: 'integer' },
      databaseDefault: { kind: 'literal', value: 0 },
      generation: { kind: 'identity', mode: 'byDefault' },
      unique: true,
    })
    const metadata = action.metadata as Record<string, unknown>
    expect(metadata).toMatchObject({
      kind: 'column',
      physicalType: { postgresql: 'integer' },
      databaseDefault: { kind: 'literal', value: 0 },
      generation: { kind: 'identity', mode: 'byDefault' },
      unique: true,
    })
  })
})

describe('getColumnMetadata', () => {
  it('should return undefined for schema without column metadata', () => {
    expect(getColumnMetadata(string())).toBeUndefined()
  })

  it('should extract column metadata from schema', () => {
    const schema = pipe(string(), column({ physicalType: { postgresql: 'text' } }))
    const metadata = getColumnMetadata(schema)
    expect(metadata).toBeDefined()
    expect(metadata!.kind).toBe('column')
    expect(metadata!.physicalType).toEqual({ postgresql: 'text' })
  })

  it('should return the correct type from metadata', () => {
    const schema = pipe(
      string(),
      column({ physicalType: { postgresql: 'varchar(255)' } }),
    )
    const metadata = getColumnMetadata(schema)
    expect(metadata).toBeDefined()
    expect(metadata!.physicalType).toEqual({ postgresql: 'varchar(255)' })
  })

  it('does not confuse another metadata kind for local column options', () => {
    const schema = pipe(string(), metadata({ kind: 'reference', target: {} }))

    expect(getColumnMetadata(schema)).toBeUndefined()
  })

  it('finds the nearest local column metadata through nested pipes and wrappers', () => {
    const schema = nullable(
      optional(
        pipe(
          pipe(string(), column({ physicalType: { postgresql: 'text' } })),
          column({ unique: true }),
        ),
      ),
    )

    expect(getColumnMetadata(schema)).toEqual({ kind: 'column', unique: true })
  })
})

describe('getColumnMetadata: ignores malformed metadata actions instead of treating them as columns', () => {
  it('ignores malformed metadata actions instead of treating them as columns', () => {
    const schema = pipe(
      string(),
      metadata({ kind: 42, physicalType: { postgresql: 'integer' } }),
    )

    expect(getColumnMetadata(schema)).toBeUndefined()
  })
})

describe('isColumnMetadata', () => {
  it('matches only the column discriminant for public metadata inspection', () => {
    expect(isColumnMetadata({ kind: 'column', unique: true })).toBe(true)
    expect(isColumnMetadata({ kind: 'reference' })).toBe(false)
    expect(isColumnMetadata({ physicalType: { postgresql: 'text' } })).toBe(false)
    expect(isColumnMetadata(undefined)).toBe(false)
  })
})
