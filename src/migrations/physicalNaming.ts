import { InvariantError, SchemaError } from '@/utils/error'

import type { CanonicalRelationIdentity } from './canonicalRelationIdentity'

type GeneratedPhysicalNameKind =
  | 'index'
  | 'primaryKey'
  | 'unique'
  | 'foreignKey'
  | 'check'

type PhysicalNameKind = GeneratedPhysicalNameKind | 'relation'

type PhysicalNameSeed = Readonly<{
  kind: GeneratedPhysicalNameKind
  owner: CanonicalRelationIdentity
  columns?: readonly string[]
  unique?: boolean
  referencedRelation?: CanonicalRelationIdentity
  referencedColumns?: readonly string[]
  onDelete?: string
  onUpdate?: string
}>

type PhysicalNamingProfile = Readonly<{
  id: string
  maximumLength: number
  lengthUnit: 'utf8Bytes' | 'unicodeScalars'
  /**
   * Converts an identifier spelling into the selected policy's comparison key.
   *
   * @param name - Physical identifier or dialect label used by this operation.
   *
   * @returns The policy-normalized key used for identifier equality.
   */
  comparisonKey(name: string): string
  /**
   * Selects the uniqueness scope used to reserve one kind of physical name.
   *
   * @param kind - Native relation or query kind used to select fixture evidence.
   *
   * @returns The physical-name uniqueness scope required by the selected dialect and
   *   object kind.
   */
  scope(
    kind: PhysicalNameKind,
  ): 'namespaceRelations' | 'relationConstraints' | 'tableLocal'
}>

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
function serializePhysicalNameSeed(seed: PhysicalNameSeed): string {
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
function physicalNameDigest(seed: PhysicalNameSeed): string {
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
    : Array.from(value).length
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
 *   const name = generatePhysicalName(seed, profile)
 *
 * @param seed - Canonical physical-name seed.
 * @param profile - Physical naming profile.
 */
function generatePhysicalName(
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
    throw new InvariantError(
      `Physical naming profile ${profile.id} cannot fit its digest`,
    )
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
function generatedIndexName(
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
function generatedPrimaryKeyName(
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
function generatedUniqueName(
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
function generatedForeignKeyName(
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
function validatePhysicalName(
  name: string,
  description: string,
  profile: PhysicalNamingProfile,
): void {
  if (name.length === 0) {
    throw new SchemaError({ message: `${description} must not be empty` })
  }

  if (name.includes('\0')) {
    throw new SchemaError({ message: `${description} must not contain NUL` })
  }

  for (let index = 0; index < name.length; index++) {
    const codeUnit = name.charCodeAt(index)

    if (codeUnit < 0xd800 || codeUnit > 0xdfff) continue

    if (codeUnit > 0xdbff || index + 1 >= name.length) {
      throw new SchemaError({
        message: `${description} must not contain unpaired Unicode surrogates`,
      })
    }

    const next = name.charCodeAt(index + 1)

    if (next < 0xdc00 || next > 0xdfff) {
      throw new SchemaError({
        message: `${description} must not contain unpaired Unicode surrogates`,
      })
    }

    index++
  }

  if (measuredLength(name, profile) > profile.maximumLength) {
    throw new SchemaError({
      message: `${description} ${JSON.stringify(name)} exceeds ${profile.id} identifier limit of ${profile.maximumLength} ${profile.lengthUnit === 'utf8Bytes' ? 'UTF-8 bytes' : 'Unicode scalars'}`,
    })
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
function physicalNameScopeKey(
  profile: PhysicalNamingProfile,
  kind: PhysicalNameKind,
  owner: CanonicalRelationIdentity,
): string {
  const scope = profile.scope(kind)

  if (scope === 'namespaceRelations') return `${scope}:${namespaceKey(owner)}`

  return `${scope}:${JSON.stringify(identityTuple(owner))}`
}

type PhysicalNameRegistry = {
  /**
   * Reserves a physical name or accepts a repeated reservation from the same owner token.
   *
   * @param options - Configuration and dependencies for this operation.
   */
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
function createPhysicalNameRegistry(
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
        throw new SchemaError({
          message: `Physical name collision for ${JSON.stringify(name)} between ${current.description} and ${description}`,
        })
      }

      names.set(key, { token, description })
    },
  }
}

export type {
  GeneratedPhysicalNameKind,
  PhysicalNameKind,
  PhysicalNameSeed,
  PhysicalNamingProfile,
  PhysicalNameRegistry,
}

export {
  serializePhysicalNameSeed,
  physicalNameDigest,
  generatePhysicalName,
  generatedIndexName,
  generatedPrimaryKeyName,
  generatedUniqueName,
  generatedForeignKeyName,
  validatePhysicalName,
  physicalNameScopeKey,
  createPhysicalNameRegistry,
}
