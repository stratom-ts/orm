import type {
  CanonicalRelationIdentity,
  RelationIdentityAdapter,
} from './canonicalRelationIdentity'

export type GeneratedPhysicalNameKind =
  | 'index'
  | 'primaryKey'
  | 'unique'
  | 'foreignKey'
  | 'check'

export type PhysicalNameKind = GeneratedPhysicalNameKind | 'relation'

export type PhysicalNameSeed = Readonly<{
  kind: GeneratedPhysicalNameKind
  owner: CanonicalRelationIdentity
  columns?: readonly string[]
  unique?: boolean
  referencedRelation?: CanonicalRelationIdentity
  referencedColumns?: readonly string[]
  onDelete?: string
  onUpdate?: string
}>

export type PhysicalNamingProfile = Readonly<{
  id: 'postgresql' | 'sqlite-fixture' | 'table-local-fixture'
  maximumLength: number
  lengthUnit: 'utf8Bytes' | 'unicodeScalars'
  comparisonKey(name: string): string
  scope(
    kind: PhysicalNameKind,
  ): 'namespaceRelations' | 'relationConstraints' | 'tableLocal'
}>

/**
 * Returns a name unchanged for exact identifier comparison.
 *
 * @example
 *   POSTGRES_PHYSICAL_NAMING.comparisonKey('Users')
 *
 * @param name - Identifier spelling.
 */
function exactKey(name: string): string {
  return name
}

/**
 * Folds ASCII uppercase characters for SQLite fixture comparison.
 *
 * @example
 *   SQLITE_PHYSICAL_NAMING_FIXTURE.comparisonKey('Users')
 *
 * @param name - Identifier spelling.
 */
function sqliteKey(name: string): string {
  let key = ''
  for (const character of name) {
    const code = character.charCodeAt(0)
    key += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : character
  }
  return key
}

export const POSTGRES_PHYSICAL_NAMING: PhysicalNamingProfile = {
  id: 'postgresql',
  maximumLength: 63,
  lengthUnit: 'utf8Bytes',
  comparisonKey: exactKey,
  /**
   * Selects the PostgreSQL uniqueness scope for a physical name.
   *
   * @example
   *   POSTGRES_PHYSICAL_NAMING.scope('index')
   *
   * @param kind - Physical-name kind.
   */
  scope: (kind) =>
    kind === 'foreignKey' || kind === 'check'
      ? 'relationConstraints'
      : 'namespaceRelations',
}

/** SQLite naming semantics fixture; this is not a production SQLite dialect. */
export const SQLITE_PHYSICAL_NAMING_FIXTURE: PhysicalNamingProfile = {
  id: 'sqlite-fixture',
  maximumLength: 255,
  lengthUnit: 'unicodeScalars',
  comparisonKey: sqliteKey,
  /**
   * Selects the SQLite fixture uniqueness scope for a physical name.
   *
   * @example
   *   SQLITE_PHYSICAL_NAMING_FIXTURE.scope('unique')
   *
   * @param kind - Physical-name kind.
   */
  scope: (kind) =>
    kind === 'foreignKey' || kind === 'check'
      ? 'relationConstraints'
      : 'namespaceRelations',
}

/** Adapter fixture proving that index names may be table-local. */
export const TABLE_LOCAL_PHYSICAL_NAMING_FIXTURE: PhysicalNamingProfile = {
  id: 'table-local-fixture',
  maximumLength: 64,
  lengthUnit: 'unicodeScalars',
  comparisonKey: sqliteKey,
  /**
   * Selects the table-local uniqueness scope.
   *
   * @example
   *   TABLE_LOCAL_PHYSICAL_NAMING_FIXTURE.scope('index')
   */
  scope: () => 'tableLocal',
}

/**
 * Selects the physical naming profile for a relation identity adapter.
 *
 * @example
 *   const profile = physicalNamingProfile('postgresql')
 *
 * @param adapter - Relation identity adapter.
 */
export function physicalNamingProfile(
  adapter: RelationIdentityAdapter,
): PhysicalNamingProfile {
  return adapter === 'postgresql'
    ? POSTGRES_PHYSICAL_NAMING
    : SQLITE_PHYSICAL_NAMING_FIXTURE
}

/**
 * Projects an identity into its canonical digest tuple.
 *
 * @param identity - Canonical relation identity.
 */
function identityTuple(identity: CanonicalRelationIdentity) {
  return [
    identity.namespace.map((segment) => [segment.role, segment.identifier.comparisonKey]),
    identity.relation.comparisonKey,
  ]
}

const UTF8_ENCODER = new TextEncoder()

/**
 * Serializes a physical-name seed into its canonical digest input.
 *
 * @example
 *   const input = serializePhysicalNameSeed(seed)
 *
 * @param seed - Physical-name seed.
 */
export function serializePhysicalNameSeed(seed: PhysicalNameSeed): string {
  return JSON.stringify([
    seed.kind,
    identityTuple(seed.owner),
    seed.columns ?? [],
    seed.unique ?? null,
    seed.referencedRelation ? identityTuple(seed.referencedRelation) : null,
    seed.referencedColumns ?? [],
    seed.onDelete ?? null,
    seed.onUpdate ?? null,
  ])
}

/**
 * Computes a 64-bit FNV-1a digest over the seed's canonical UTF-8 serialization.
 *
 * @example
 *   const digest = physicalNameDigest(seed)
 *
 * @param seed - Physical-name seed.
 */
export function physicalNameDigest(seed: PhysicalNameSeed): string {
  let digest = 0xcbf29ce484222325n
  for (const byte of UTF8_ENCODER.encode(serializePhysicalNameSeed(seed))) {
    digest ^= BigInt(byte)
    digest = BigInt.asUintN(64, digest * 0x100000001b3n)
  }
  return digest.toString(16).padStart(16, '0')
}

/**
 * Measures a name using a profile's configured length unit.
 *
 * @param value - Name to measure.
 * @param profile - Physical naming profile.
 */
function measuredLength(value: string, profile: PhysicalNamingProfile): number {
  return profile.lengthUnit === 'utf8Bytes'
    ? UTF8_ENCODER.encode(value).length
    : [...value].length
}

/**
 * Truncates a readable prefix without splitting a Unicode scalar.
 *
 * @param prefix - Prefix to truncate.
 * @param available - Maximum measured length.
 * @param profile - Physical naming profile.
 */
function truncatePrefix(
  prefix: string,
  available: number,
  profile: PhysicalNamingProfile,
): string {
  let result = ''
  for (const scalar of prefix) {
    if (measuredLength(result + scalar, profile) > available) break
    result += scalar
  }
  return result
}

const SUFFIX: Record<GeneratedPhysicalNameKind, string> = {
  index: 'idx',
  primaryKey: 'pkey',
  unique: 'key',
  foreignKey: 'fkey',
  check: 'check',
}

/**
 * Generates a deterministic physical name within a profile's length limit.
 *
 * @example
 *   const name = generatePhysicalName(seed, POSTGRES_PHYSICAL_NAMING)
 *
 * @param seed - Canonical physical-name seed.
 * @param profile - Physical naming profile.
 */
export function generatePhysicalName(
  seed: PhysicalNameSeed,
  profile: PhysicalNamingProfile,
): string {
  const readable = [seed.owner.relation.spelling, ...(seed.columns ?? [])].join('_')
  const canonicalSeed: PhysicalNameSeed = {
    ...seed,
    ...(seed.columns
      ? { columns: seed.columns.map((column) => profile.comparisonKey(column)) }
      : {}),
    ...(seed.referencedColumns
      ? {
          referencedColumns: seed.referencedColumns.map((column) =>
            profile.comparisonKey(column),
          ),
        }
      : {}),
  }
  const fixed = `__${physicalNameDigest(canonicalSeed)}_${SUFFIX[seed.kind]}`
  const available = profile.maximumLength - measuredLength(fixed, profile)
  if (available < 0) {
    throw new TypeError(`Physical naming profile ${profile.id} cannot fit its digest`)
  }
  return `${truncatePrefix(readable, available, profile)}${fixed}`
}

/**
 * Generates the physical name for an index.
 *
 * @example
 *   const name = generatedIndexName(owner, ['email'], true, profile)
 *
 * @param owner - Owning relation identity.
 * @param columns - Indexed column spellings.
 * @param unique - Whether the index is unique.
 * @param profile - Physical naming profile.
 */
export function generatedIndexName(
  owner: CanonicalRelationIdentity,
  columns: readonly string[],
  unique: boolean,
  profile: PhysicalNamingProfile,
): string {
  return generatePhysicalName({ kind: 'index', owner, columns, unique }, profile)
}

/**
 * Generates the physical name for a primary key.
 *
 * @example
 *   const name = generatedPrimaryKeyName(owner, ['id'], profile)
 *
 * @param owner - Owning relation identity.
 * @param columns - Primary-key column spellings.
 * @param profile - Physical naming profile.
 */
export function generatedPrimaryKeyName(
  owner: CanonicalRelationIdentity,
  columns: readonly string[],
  profile: PhysicalNamingProfile,
): string {
  return generatePhysicalName({ kind: 'primaryKey', owner, columns }, profile)
}

/**
 * Generates the physical name for a single-column unique constraint.
 *
 * @example
 *   const name = generatedUniqueName(owner, 'email', profile)
 *
 * @param owner - Owning relation identity.
 * @param column - Unique column spelling.
 * @param profile - Physical naming profile.
 */
export function generatedUniqueName(
  owner: CanonicalRelationIdentity,
  column: string,
  profile: PhysicalNamingProfile,
): string {
  return generatePhysicalName({ kind: 'unique', owner, columns: [column] }, profile)
}

/**
 * Generates the physical name for a single-column foreign key.
 *
 * @example
 *   const name = generatedForeignKeyName(owner, 'team_id', team, 'id', undefined, undefined, profile)
 *
 * @param owner - Owning relation identity.
 * @param column - Referencing column spelling.
 * @param referencedRelation - Referenced relation identity.
 * @param referencedColumn - Referenced column spelling.
 * @param onDelete - Optional delete action.
 * @param onUpdate - Optional update action.
 * @param profile - Physical naming profile.
 */
export function generatedForeignKeyName(
  owner: CanonicalRelationIdentity,
  column: string,
  referencedRelation: CanonicalRelationIdentity,
  referencedColumn: string,
  onDelete: string | undefined,
  onUpdate: string | undefined,
  profile: PhysicalNamingProfile,
): string {
  return generatePhysicalName(
    {
      kind: 'foreignKey',
      owner,
      columns: [column],
      referencedRelation,
      referencedColumns: [referencedColumn],
      onDelete: onDelete?.toLowerCase() ?? 'no action',
      onUpdate: onUpdate?.toLowerCase() ?? 'no action',
    },
    profile,
  )
}

/**
 * Validates a physical identifier against a naming profile.
 *
 * @example
 *   validatePhysicalName('users_pkey', 'primary key name', profile)
 *
 * @param name - Physical identifier spelling.
 * @param description - Description used in validation errors.
 * @param profile - Physical naming profile.
 */
export function validatePhysicalName(
  name: string,
  description: string,
  profile: PhysicalNamingProfile,
): void {
  if (name.length === 0) {
    throw new TypeError(`${description} must not be empty`)
  }
  if (name.includes('\0')) {
    throw new TypeError(`${description} must not contain NUL`)
  }
  for (let index = 0; index < name.length; index++) {
    const codeUnit = name.charCodeAt(index)
    if (codeUnit < 0xd800 || codeUnit > 0xdfff) continue
    if (codeUnit > 0xdbff || index + 1 >= name.length) {
      throw new TypeError(`${description} must not contain unpaired Unicode surrogates`)
    }
    const next = name.charCodeAt(index + 1)
    if (next < 0xdc00 || next > 0xdfff) {
      throw new TypeError(`${description} must not contain unpaired Unicode surrogates`)
    }
    index++
  }
  if (measuredLength(name, profile) > profile.maximumLength) {
    throw new TypeError(
      `${description} ${JSON.stringify(name)} exceeds ${profile.id} identifier limit of ${profile.maximumLength} ${profile.lengthUnit === 'utf8Bytes' ? 'UTF-8 bytes' : 'Unicode scalars'}`,
    )
  }
}

/**
 * Serializes the namespace portion of a canonical identity.
 *
 * @param identity - Canonical relation identity.
 */
function namespaceKey(identity: CanonicalRelationIdentity): string {
  return JSON.stringify(
    identity.namespace.map((segment) => [segment.role, segment.identifier.comparisonKey]),
  )
}

/**
 * Builds the registry key for a physical-name uniqueness scope.
 *
 * @example
 *   const key = physicalNameScopeKey(profile, 'index', owner)
 *
 * @param profile - Physical naming profile.
 * @param kind - Physical-name kind.
 * @param owner - Owning relation identity.
 */
export function physicalNameScopeKey(
  profile: PhysicalNamingProfile,
  kind: PhysicalNameKind,
  owner: CanonicalRelationIdentity,
): string {
  const scope = profile.scope(kind)
  if (scope === 'namespaceRelations') return `${scope}:${namespaceKey(owner)}`
  return `${scope}:${JSON.stringify(identityTuple(owner))}`
}

export type PhysicalNameRegistry = {
  reserve(options: {
    kind: PhysicalNameKind
    owner: CanonicalRelationIdentity
    name: string
    token: string
    description: string
  }): void
}

/**
 * Creates a collision-detecting physical-name registry.
 *
 * @example
 *   const registry = createPhysicalNameRegistry(profile)
 *
 * @param profile - Physical naming profile.
 */
export function createPhysicalNameRegistry(
  profile: PhysicalNamingProfile,
): PhysicalNameRegistry {
  const names = new Map<string, { token: string; description: string }>()
  return {
    /**
     * Reserves a physical name or verifies an idempotent reservation.
     *
     * @example
     *   registry.reserve({ kind: 'index', owner, name, token: 'users.email', description: 'email index' })
     *
     * @param options - Physical-name reservation fields.
     */
    reserve({ kind, owner, name, token, description }) {
      validatePhysicalName(name, description, profile)
      const key = `${physicalNameScopeKey(profile, kind, owner)}:${JSON.stringify(
        profile.comparisonKey(name),
      )}`
      const current = names.get(key)
      if (current && current.token !== token) {
        throw new TypeError(
          `Physical name collision for ${JSON.stringify(name)} between ${current.description} and ${description}`,
        )
      }
      names.set(key, { token, description })
    },
  }
}
