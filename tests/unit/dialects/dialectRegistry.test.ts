import type { SQLDialect } from 'db0'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { defineDialect } from '@/dialects/defineDialect'
import {
  createDialectRegistry,
  productionDialects,
  registerDialectForTest,
  resolveDialect,
} from '@/dialects/resolve'
import type { Dialect } from '@/dialects/types'

describe('production dialect construction and registration', () => {
  it('should require every facet and only dialect-specific Migration behavior', () => {
    type Definition = Parameters<typeof defineDialect>[0]

    type ExpectedDefinition = Omit<Dialect, 'migration'> &
      Pick<Dialect['migration'], 'lower' | 'execute'>

    expectTypeOf<Definition>().toEqualTypeOf<ExpectedDefinition>()
  })

  it('should resolve every production member with exact Migration facet bindings', () => {
    for (const dialect of productionDialects) {
      expect(resolveDialect(dialect.id as SQLDialect)).toBe(dialect)
      expect(typeof dialect.classifyDriverError).toBe('function')
      expect(dialect.migration.planning.identity).toBe(dialect.identity)
      expect(dialect.migration.planning.naming).toBe(dialect.naming)
      expect(dialect.migration.planning.schema).toBe(dialect.schema)
      expect(dialect.migration.catalog).toBe(dialect.catalog)
    }
  })
})

describe('production dialect registry validation', () => {
  it.each([
    ['non-string', undefined],
    ['empty', ''],
    ['leading whitespace', ' dialect'],
    ['trailing whitespace', 'dialect '],
    ['NUL', 'dia\0lect'],
  ])('should reject a %s production member id', (_name, id) => {
    const dialect = { ...productionDialects[0], id } as unknown as Dialect

    expect(() => createDialectRegistry([dialect])).toThrow(
      'dialect id must be a non-empty identifier',
    )
  })

  it('should reject duplicate production member ids', () => {
    const dialect = productionDialects[0]

    expect(() => createDialectRegistry([dialect, dialect])).toThrow(
      `dialect "${dialect.id}" is already registered`,
    )
  })

  it('should report every supported id in deterministic order', () => {
    const testDialect = { ...productionDialects[0], id: 'aaa-test-dialect' }
    const unregister = registerDialectForTest(testDialect)

    try {
      expect(() => resolveDialect('unsupported-test-dialect' as SQLDialect)).toThrow(
        `supported: ${[...productionDialects.map(({ id }) => id), testDialect.id]
          .sort()
          .join(', ')}`,
      )
    } finally {
      unregister()
    }
  })
})
