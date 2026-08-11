import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, getColumnMetadata } from '@/index'

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
})
