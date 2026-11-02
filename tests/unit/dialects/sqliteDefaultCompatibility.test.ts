import { array, object, pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { assertSqliteDefaultCompatibility } from '@/dialects/sqlite/defaultCompatibility'
import { extractStorageFacts } from '@/schemas/valibot/storageFacts'
import type { AnySchema } from '@/types/schema'

function registerDefaultCompatibilityGroup1() {
  it('should preserve defects from SQLite result mapping during default validation', async () => {
    const defect = new TypeError('mapping failed')
    const mapping = await import('@/dialects/sqlite/mapping')

    const spy = vi
      .spyOn(mapping, 'mapSqliteResultValueFromFacts')
      .mockImplementation(() => {
        throw defect
      })

    try {
      let failure: unknown
      try {
        assertSqliteDefaultCompatibility(
          { kind: 'literal', value: 'ok' },
          'TEXT',
          extractStorageFacts(string()),
          false,
          'records.value',
        )
      } catch (cause) {
        failure = cause
      }

      expect(failure).toBe(defect)
      expect((failure as Error).stack).toBe(defect.stack)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the base array default policy for a transformed pipeline', () => {
    const schema = pipe(array(string()) as AnySchema, object({}) as AnySchema)
    expect(() =>
      assertSqliteDefaultCompatibility(
        { kind: 'literal', value: '[]' },
        'JSON',
        extractStorageFacts(schema),
        false,
        'records.value',
      ),
    ).not.toThrow()

    expect(() =>
      assertSqliteDefaultCompatibility(
        { kind: 'literal', value: '{}' },
        'JSON',
        extractStorageFacts(schema),
        false,
        'records.value',
      ),
    ).toThrow('incompatible')
  })
}

describe('SQLite default compatibility', () => {
  registerDefaultCompatibilityGroup1()
})
