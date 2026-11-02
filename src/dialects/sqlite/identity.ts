import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type {
  CanonicalRelationIdentityModule,
  CanonicalRelationIdentityPolicy,
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { InvariantError, SchemaError } from '@/utils/error'

const SQLITE_IDENTITY = 'sqlite' as const

/** SQLite compares only ASCII letters without regard to case. */
function asciiFoldSqliteIdentifier(spelling: string): string {
  let key = ''

  for (const character of spelling) {
    const code = character.charCodeAt(0)
    key += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : character
  }

  return key
}

/** Rejects namespaces that do not contain exactly one database role. */
function requireDatabaseNamespace(
  namespace: readonly NamespaceIdentifierInput[],
  description: string,
): void {
  if (namespace.length !== 1 || namespace[0]?.role !== 'database') {
    throw new InvariantError(`${description} must have ordered roles database`)
  }
}

/** Canonical SQLite database-alias and relation identity semantics. */
const SQLITE_IDENTITY_POLICY: CanonicalRelationIdentityPolicy = {
  id: SQLITE_IDENTITY,
  comparisonKey: asciiFoldSqliteIdentifier,
  /** Resolves authored namespace segments using the configured writable defaults. */
  resolveNamespace(selected, writableDefault) {
    requireDatabaseNamespace(writableDefault, 'SQLite writable default')

    if (selected.length !== 1 || selected[0]?.role !== 'database') {
      throw new SchemaError({
        message: 'SQLite relation namespace must have ordered roles database',
      })
    }

    return selected
  },
}

/** SQLite identity semantics, including attached-alias canonicalization. */
export const sqliteIdentity = {
  id: SQLITE_IDENTITY,
  /** Binds canonical relation identity operations to the configured namespace context. */
  create(options: {
    context: NamespaceContext
    registrationDefault?: readonly NamespaceIdentifierInput[]
  }): CanonicalRelationIdentityModule {
    return createCanonicalRelationIdentityModule({
      policy: SQLITE_IDENTITY_POLICY,
      ...options,
    })
  },
}

export { asciiFoldSqliteIdentifier, SQLITE_IDENTITY_POLICY }
