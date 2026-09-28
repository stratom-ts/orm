import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type {
  CanonicalRelationIdentityPolicy,
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { InvariantError } from '@/utils/error'

const SQLITE_IDENTITY = 'sqlite' as const

/** SQLite compares only ASCII letters without regard to case. */
export function asciiFoldSqliteIdentifier(spelling: string): string {
  let key = ''

  for (const character of spelling) {
    const code = character.charCodeAt(0)
    key += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : character
  }

  return key
}

function requireDatabaseNamespace(
  namespace: readonly NamespaceIdentifierInput[],
  description: string,
): void {
  if (namespace.length !== 1 || namespace[0]?.role !== 'database') {
    throw new InvariantError(`${description} must have ordered roles database`)
  }
}

/** Canonical SQLite database-alias and relation identity semantics. */
export const SQLITE_IDENTITY_POLICY: CanonicalRelationIdentityPolicy = {
  id: SQLITE_IDENTITY,
  comparisonKey: asciiFoldSqliteIdentifier,
  resolveNamespace(selected, writableDefault) {
    requireDatabaseNamespace(writableDefault, 'SQLite writable default')
    requireDatabaseNamespace(selected, 'SQLite relation namespace')
    return selected
  },
}

/** SQLite identity semantics, including attached-alias canonicalization. */
export const sqliteIdentity = {
  id: SQLITE_IDENTITY,
  create(options: {
    context: NamespaceContext
    registrationDefault?: readonly NamespaceIdentifierInput[]
  }) {
    return createCanonicalRelationIdentityModule({
      policy: SQLITE_IDENTITY_POLICY,
      ...options,
    })
  },
}
