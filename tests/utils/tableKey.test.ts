import { describe, expect, it } from 'vitest'

import { tableKey } from '@/index'

describe('tableKey legacy compatibility', () => {
  it('keeps its dotted serialization unchanged', () => {
    expect(tableKey(undefined, 'users')).toBe('public.users')
    expect(tableKey('a.b', 'c')).toBe('a.b.c')
    expect(tableKey('a', 'b.c')).toBe('a.b.c')
  })
})
