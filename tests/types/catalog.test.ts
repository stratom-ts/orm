import { describe, expectTypeOf, it } from 'vitest'

import type {
  CatalogCoverage,
  CatalogFact,
  CatalogIntrospector,
  CatalogNoEvidence,
  CatalogSet,
  Dialect,
} from '@/index'

describe('public catalog evidence types', () => {
  it('exports evidence separately from collection coverage and capabilities', () => {
    expectTypeOf<CatalogFact<string>>().toMatchTypeOf<
      { state: 'present'; value: string } | { state: 'absent' } | CatalogNoEvidence
    >()
    expectTypeOf<CatalogCoverage>().toMatchTypeOf<
      | { state: 'complete' }
      | { state: 'partial'; remainder: CatalogNoEvidence }
      | CatalogNoEvidence
    >()
    expectTypeOf<CatalogSet<string>>().toMatchTypeOf<{
      items: readonly string[]
      coverage: CatalogCoverage
    }>()
  })

  it('exposes one scoped catalog module on a dialect', () => {
    expectTypeOf<Dialect['catalog']>().toEqualTypeOf<CatalogIntrospector>()
    expectTypeOf<Dialect>().not.toHaveProperty('introspect')
  })
})
