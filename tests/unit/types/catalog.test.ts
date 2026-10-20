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
  it('should export evidence separately from collection coverage and capabilities', () => {
    expectTypeOf<CatalogFact<string>>().toEqualTypeOf<
      | { readonly state: 'present'; readonly value: string }
      | { readonly state: 'absent' }
      | CatalogNoEvidence
    >()

    expectTypeOf<CatalogCoverage>().toEqualTypeOf<
      | { readonly state: 'complete' }
      | { readonly state: 'partial'; readonly remainder: CatalogNoEvidence }
      | CatalogNoEvidence
    >()

    expectTypeOf<CatalogSet<string>>().toEqualTypeOf<{
      readonly items: readonly string[]
      readonly coverage: CatalogCoverage
    }>()
  })

  it('should expose one scoped catalog module on a dialect', () => {
    expectTypeOf<Dialect['catalog']>().toEqualTypeOf<CatalogIntrospector>()
    expectTypeOf<Dialect>().not.toHaveProperty('introspect')
  })
})
