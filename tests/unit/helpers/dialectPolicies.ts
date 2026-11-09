import type {
  CanonicalRelationIdentityPolicy,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import type { PhysicalNamingProfile } from '@/migrations/physicalNaming'
import { InvariantError } from '@/utils/error'

/**
 * Folds ASCII uppercase letters while preserving every other character.
 *
 * @param spelling - Authored identifier spelling before canonicalization.
 *
 * @returns The spelling with ASCII uppercase folded and other characters unchanged.
 */
function asciiCaseFold(spelling: string): string {
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
  if (namespace.length !== 1 || namespace[0]?.role !== 'database')
    throw new InvariantError(`${description} must have ordered roles database`)
}

/** Test-only attached-database identity semantics; not a production dialect. */
export const SQLITE_IDENTITY_POLICY: CanonicalRelationIdentityPolicy = {
  id: 'sqlite-fixture',
  comparisonKey: asciiCaseFold,
  /** Resolves authored namespace segments using the configured writable defaults. */
  resolveNamespace(selected, writableDefault) {
    requireDatabaseNamespace(writableDefault, 'SQLite writable default')
    requireDatabaseNamespace(selected, 'SQLite relation namespace')
    return selected
  },
}

/** Test-only attached-database physical naming semantics. */
export const SQLITE_PHYSICAL_NAMING_FIXTURE: PhysicalNamingProfile = {
  id: 'sqlite-fixture',
  maximumLength: 255,
  lengthUnit: 'unicodeScalars',
  comparisonKey: asciiCaseFold,
  /** Selects the uniqueness scope used to reserve one kind of physical name. */
  scope: (kind) =>
    kind === 'foreignKey' || kind === 'check'
      ? 'relationConstraints'
      : 'namespaceRelations',
}

/** Test-only profile proving that physical names may be table-local. */
export const TABLE_LOCAL_PHYSICAL_NAMING_FIXTURE: PhysicalNamingProfile = {
  id: 'table-local-fixture',
  maximumLength: 64,
  lengthUnit: 'unicodeScalars',
  comparisonKey: asciiCaseFold,
  /** Selects the uniqueness scope used to reserve one kind of physical name. */
  scope: () => 'tableLocal',
}
