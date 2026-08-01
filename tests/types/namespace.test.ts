import { describe, expectTypeOf, it } from 'vitest'

import type {
  NamespaceContext,
  NamespaceIdentifierInput,
  NamespaceRole,
  RelationIdentityAdapter,
} from '@/index'

describe('public migration namespace types', () => {
  it('exports the custom dialect namespace contract', () => {
    expectTypeOf<NamespaceRole>().toEqualTypeOf<'catalog' | 'database' | 'schema'>()
    expectTypeOf<NamespaceIdentifierInput>().toEqualTypeOf<
      Readonly<{ role: NamespaceRole; spelling: string }>
    >()
    expectTypeOf<NamespaceContext>().toEqualTypeOf<
      Readonly<{ writableDefault: readonly NamespaceIdentifierInput[] }>
    >()
    expectTypeOf<RelationIdentityAdapter>().toEqualTypeOf<'postgresql' | 'sqlite'>()
  })
})
