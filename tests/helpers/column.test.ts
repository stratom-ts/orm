import { boolean, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { getColumnInfo } from '@/helpers'

describe('column.ts', () => {
  describe('getColumnInfo', () => {
    it('should return column info with dataType from column metadata', () => {
      const schema = string()

      const result = getColumnInfo(
        schema,
        { kind: 'column', type: 'varchar' },
        undefined,
      )

      expect(result.dataType).toBe('varchar')
      expect(result.nullable).toBe(false)
      expect(result.unique).toBe(false)
      expect(result.autoIncrement).toBe(false)
    })

    it('should infer type from schema when no metadata provided', () => {
      const schema = string()

      const result = getColumnInfo(schema, undefined, undefined)

      expect(result.dataType).toBe('text')
      expect(result.nullable).toBe(false)
      expect(result.unique).toBe(false)
      expect(result.autoIncrement).toBe(false)
    })

    it('should return default value from column metadata', () => {
      const schema = string()

      const result = getColumnInfo(
        schema,
        { kind: 'column', type: 'varchar', default: 'test' },
        undefined,
      )

      expect(result.defaultValue).toBe('test')
    })

    it('should return autoIncrement from column metadata', () => {
      const schema = string()

      const result = getColumnInfo(
        schema,
        { kind: 'column', type: 'integer', autoIncrement: true },
        undefined,
      )

      expect(result.autoIncrement).toBe(true)
    })

    it('should infer boolean type correctly', () => {
      const schema = boolean()

      const result = getColumnInfo(schema, undefined, undefined)

      expect(result.dataType).toBe('boolean')
    })
  })
})
