import { expect, it } from 'vitest'

import {
  isSqliteDefaultExpression,
  isSqliteDefaultLiteral,
} from '@/dialects/sqlite/defaults'
import { assertSafeSqliteDefaultExpression } from '@/dialects/sqlite/validate'

it.each([
  'false',
  'TRUE',
  '1e20',
  '- .5e-2',
  '+1.',
  "X'ff'",
  "x''",
  "'a'';--b'",
  'null',
  '0xFF',
])('recognizes and preserves the native literal %s', (value) => {
  expect(isSqliteDefaultLiteral(value)).toBe(true)
  expect(assertSafeSqliteDefaultExpression(value)).toBe(value)
})

it.each([
  'abs()',
  'abs(1,2)',
  'abs(,1)',
  'abs(1,)',
  'abs(1,,2)',
  'abs(1 2)',
  'coalesce(1)',
  'ifnull(1)',
  'replace(1,2)',
  'min(1)',
  'max(1)',
  'abs',
  'current_timestamp()',
  'lower(abs())',
  'cast(1 as)',
  '1e',
  "X'f'",
  '0x1234567890abcdef0',
  '1 +',
  '(1,2)',
  '1--2',
  'format(1)',
  'unixepoch()',
  'abs(-9223372036854775808)',
  'abs(+( -9223372036854775808 ))',
  'abs(0x8000000000000000)',
  'cast(1as integer)',
  'cast(1e2as integer)',
  'abs(\u00a01)',
  '\u00a01',
  '1\u00a0',
  'abs(\v1)',
  "abs(cast('-9223372036854775808' as integer))",
  'abs(-2147483648 * 4294967296)',
  'abs(min(-9223372036854775808, 1))',
])('rejects unusable default syntax or call %s deterministically', (value) => {
  expect(() => assertSafeSqliteDefaultExpression(value)).toThrow(
    `Unsafe SQLite database expression ${JSON.stringify(value)}`,
  )
})

it.each([
  '(false)',
  "lower(trim(' A '))",
  'abs(-12)',
  'min(1,2)',
  'sign(-1)',
  "cast('12' as INTEGER) + 3 * 2",
  "strftime('%s','2026-01-01')",
  'date()',
  "char() || 'x'",
  "hex(X'ff')",
  'CURRENT_TIMESTAMP',
  '1 - -2',
  'abs(-922337203685477580+8)',
  "abs(length('value'))",
  "abs(cast('-9223372036854775808' as REAL))",
  'abs(\t\r\n\f 1)',
])('accepts the supported constant expression %s', (value) => {
  expect(assertSafeSqliteDefaultExpression(value)).toBe(value)
})

it('fails closed on nesting beyond the supported expression bound', () => {
  const value = `${'('.repeat(30)}1${')'.repeat(30)}`
  expect(() => assertSafeSqliteDefaultExpression(value)).toThrow(/Unsafe SQLite/)
})

it.each([
  { value: `+${Array.from({ length: 128 }, () => '1').join('+')}`, accepted: true },
  { value: Array.from({ length: 129 }, () => '1').join('+'), accepted: false },
])(
  'enforces the token bound for a flat expression (accepted: $accepted)',
  ({ value, accepted }) => {
    expect(isSqliteDefaultExpression(value)).toBe(accepted)
  },
)
