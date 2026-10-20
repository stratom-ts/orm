import { expect, it } from 'vitest'

import { normalizeSqliteDefaultExpression } from '@/dialects/sqlite/normalize'
import { assertSafeSqliteDefaultExpression } from '@/dialects/sqlite/validate'

it('normalizes only unquoted spacing and retains escaped quotes in SQL strings', () => {
  expect(normalizeSqliteDefaultExpression(" ( lower(  'a''  b' ) ) ")).toBe(
    "lower( 'a''  b' )",
  )

  expect(normalizeSqliteDefaultExpression("'a\t\n b'")).toBe("'a\t\n b'")
})

it.each([
  "'x'; drop table records",
  "lower('x') -- comment",
  "'x' /* comment */",
  "'x'::text",
  '$value',
  '(select 1)',
  "lower('unterminated)",
])(
  'rejects executable or malformed SQL default %s outside string literals',
  (expression) => {
    expect(() => assertSafeSqliteDefaultExpression(expression)).toThrow(
      /Unsafe SQLite database expression/,
    )
  },
)
