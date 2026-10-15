import { string } from 'valibot'
import { expect, it, vi } from 'vitest'

import { assertSqliteDefaultCompatibility } from '@/dialects/sqlite/defaultCompatibility'

it('preserves defects from SQLite result mapping during default validation', async () => {
  const defect = new TypeError('mapping failed')
  const mapping = await import('@/dialects/sqlite/mapping')

  const spy = vi.spyOn(mapping, 'mapSqliteResultValue').mockImplementation(() => {
    throw defect
  })

  try {
    let failure: unknown
    try {
      assertSqliteDefaultCompatibility(
        { kind: 'literal', value: 'ok' },
        'TEXT',
        string(),
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
