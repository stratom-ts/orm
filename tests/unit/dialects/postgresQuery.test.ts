import { describe, expect, it } from 'vitest'

import { compilePostgres } from '@/dialects/postgres/compile'

describe('PostgreSQL query', () => {
  it('should reject empty select and returning AST projections', () => {
    expect(() =>
      compilePostgres({ kind: 'select', relation: { relation: 't' }, selection: [] }),
    ).toThrow(/select items must not be empty/)

    expect(() =>
      compilePostgres({
        kind: 'insert',
        relation: { relation: 't' },
        columns: ['id'],
        values: [[1]],
        returning: { kind: 'columns', columns: [] },
      }),
    ).toThrow(/returning columns must not be empty/)
  })
})
