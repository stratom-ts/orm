import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type {
  CanonicalRelationIdentityModule,
  CanonicalRelationIdentityPolicy,
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { InvariantError } from '@/utils/error'

const POSTGRES_IDENTITY = 'postgresql' as const
const POSTGRES_POLICY: CanonicalRelationIdentityPolicy = {
  id: POSTGRES_IDENTITY,
  /** Converts an identifier spelling into the selected policy's comparison key. */
  comparisonKey: (spelling) => spelling,
  /**
   * Resolves authored namespace segments using the configured writable defaults.
   *
   * @param selected - Authored namespace selected before applying writable defaults.
   * @param writableDefault - Writable namespace supplied by the native session.
   *
   * @returns Authored namespace segments using the configured writable defaults.
   */
  resolveNamespace(selected, writableDefault) {
    if (
      writableDefault.length !== 2 ||
      writableDefault[0]?.role !== 'database' ||
      writableDefault[1]?.role !== 'schema'
    ) {
      throw new InvariantError(
        'PostgreSQL writable default must have ordered roles database, schema',
      )
    }

    if (selected.length === 1 && selected[0]?.role === 'schema') {
      return [writableDefault[0]!, selected[0]]
    }

    if (
      selected.length !== 2 ||
      selected[0]?.role !== 'database' ||
      selected[1]?.role !== 'schema'
    ) {
      throw new InvariantError(
        'PostgreSQL relation namespace must have ordered roles database, schema',
      )
    }

    if (selected[0]!.spelling !== writableDefault[0]!.spelling) {
      throw new InvariantError(
        'PostgreSQL relation database must match the writable database',
      )
    }

    return selected
  },
}

/** PostgreSQL identity semantics, bound to the selected dialect member. */
export const postgresIdentity = {
  id: POSTGRES_IDENTITY,
  /** Binds canonical relation identity operations to the configured namespace context. */
  create(options: {
    context: NamespaceContext
    registrationDefault?: readonly NamespaceIdentifierInput[]
  }): CanonicalRelationIdentityModule {
    return createCanonicalRelationIdentityModule({ policy: POSTGRES_POLICY, ...options })
  },
}

export { POSTGRES_POLICY }
