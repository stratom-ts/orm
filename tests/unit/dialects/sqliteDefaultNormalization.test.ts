import { describe, expect, it } from 'vitest'

import { normalizeSqliteDefaultExpression } from '@/dialects/sqlite/normalize'
import { assertSafeSqliteDefaultExpression } from '@/dialects/sqlite/validate'

function registerDefaultNormalizationGroup1() {
  it('should normalize only unquoted spacing and retain escaped quotes in SQL strings', () => {
    expect(normalizeSqliteDefaultExpression(" ( lower(  'a''  b' ) ) ")).toBe(
      "lower( 'a''  b' )",
    )

    expect(normalizeSqliteDefaultExpression("'a\t\n b'")).toBe("'a\t\n b'")
  })
}

function registerDefaultNormalizationGroup2() {
  it.each([
    "'x'; drop table records",
    "lower('x') -- comment",
    "'x' /* comment */",
    "'x'::text",
    '$value',
    '(select 1)',
    "lower('unterminated)",
  ])(
    'should reject executable or malformed SQL default %s outside string literals',
    (expression) => {
      expect(() => assertSafeSqliteDefaultExpression(expression)).toThrow(
        /Unsafe SQLite database expression/,
      )
    },
  )
}

describe('SQLite default normalization', () => {
  registerDefaultNormalizationGroup1()
  registerDefaultNormalizationGroup2()
})
