import { describe, expect, it } from 'vitest'

import { normalizePostgresDefaultExpression } from '@/dialects/postgres/validate'

describe('PostgreSQL default-expression normalization', () => {
  it.each([
    'current_timestamp',
    'CURRENT_TIMESTAMP',
    '(CURRENT_TIMESTAMP)',
    '((CURRENT_TIMESTAMP))::timestamp with time zone',
    '(CURRENT_TIMESTAMP::timestamp with time zone)',
  ])('canonicalizes the current timestamp catalog form %j', (expression) => {
    expect(normalizePostgresDefaultExpression(expression)).toBe('current_timestamp')
  })

  it.each([
    ["'CURRENT_TIMESTAMP'", "'CURRENT_TIMESTAMP'"],
    ["'CURRENT_TIMESTAMP'::text", "'CURRENT_TIMESTAMP'"],
    ['clock_timestamp()', 'clock_timestamp()'],
    [
      "CURRENT_TIMESTAMP + interval '1 second'",
      "CURRENT_TIMESTAMP + interval '1 second'",
    ],
  ])('keeps the literal or unrelated expression %j distinct', (expression, expected) => {
    expect(normalizePostgresDefaultExpression(expression)).toBe(expected)
  })
})
