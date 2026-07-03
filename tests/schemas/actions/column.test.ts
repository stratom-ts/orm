import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, getColumnMetadata } from '@/schemas'

describe('column action', () => {
  it('should create column metadata action with correct kind', () => {
    const action = column({ type: 'varchar' })
    expect(action.type).toBe('metadata')
    const metadata = action.metadata as Record<string, unknown>
    expect(metadata.kind).toBe('column')
    expect(metadata.type).toBe('varchar')
  })

  it('should create column with all options', () => {
    const action = column({
      type: 'integer',
      default: 0,
      autoIncrement: true,
      unique: true,
    })
    const metadata = action.metadata as Record<string, unknown>
    expect(metadata).toMatchObject({
      kind: 'column',
      type: 'integer',
      default: 0,
      autoIncrement: true,
      unique: true,
    })
  })
})

describe('getColumnMetadata', () => {
  it('should return undefined for schema without column metadata', () => {
    expect(getColumnMetadata(string())).toBeUndefined()
  })

  it('should extract column metadata from schema', () => {
    const schema = pipe(string(), column({ type: 'text' }))
    const metadata = getColumnMetadata(schema)
    expect(metadata).toBeDefined()
    expect(metadata!.kind).toBe('column')
    expect(metadata!.type).toBe('text')
  })

  it('should return the correct type from metadata', () => {
    const schema = pipe(
      string(),
      column({ type: 'varchar(255)' }),
    )
    const metadata = getColumnMetadata(schema)
    expect(metadata).toBeDefined()
    expect(metadata!.type).toBe('varchar(255)')
  })
})
