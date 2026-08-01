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

function exactKey(name: string): string {
  return name
}

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
  scope: () => 'tableLocal',
}

export function physicalNamingProfile(
  adapter: RelationIdentityAdapter,
): PhysicalNamingProfile {
  return adapter === 'postgresql'
    ? POSTGRES_PHYSICAL_NAMING
    : SQLITE_PHYSICAL_NAMING_FIXTURE
}

function identityTuple(identity: CanonicalRelationIdentity) {
  return [
    identity.namespace.map((segment) => [segment.role, segment.identifier.comparisonKey]),
    identity.relation.comparisonKey,
  ]
}

/** Canonical JSON serialization is the documented digest input. */
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

/** 64-bit FNV-1a over UTF-8, rendered as 16 lowercase hexadecimal digits. */
export function physicalNameDigest(seed: PhysicalNameSeed): string {
  let digest = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(serializePhysicalNameSeed(seed))) {
    digest ^= BigInt(byte)
    digest = BigInt.asUintN(64, digest * 0x100000001b3n)
  }
  return digest.toString(16).padStart(16, '0')
}

function measuredLength(value: string, profile: PhysicalNamingProfile): number {
  return profile.lengthUnit === 'utf8Bytes'
    ? new TextEncoder().encode(value).length
    : [...value].length
}

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

export function generatedIndexName(
  owner: CanonicalRelationIdentity,
  columns: readonly string[],
  unique: boolean,
  profile: PhysicalNamingProfile,
): string {
  return generatePhysicalName({ kind: 'index', owner, columns, unique }, profile)
}

export function generatedPrimaryKeyName(
  owner: CanonicalRelationIdentity,
  columns: readonly string[],
  profile: PhysicalNamingProfile,
): string {
  return generatePhysicalName({ kind: 'primaryKey', owner, columns }, profile)
}

export function generatedUniqueName(
  owner: CanonicalRelationIdentity,
  column: string,
  profile: PhysicalNamingProfile,
): string {
  return generatePhysicalName({ kind: 'unique', owner, columns: [column] }, profile)
}

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
    const next = name.charCodeAt(index + 1)
    if (codeUnit > 0xdbff || next < 0xdc00 || next > 0xdfff) {
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

function namespaceKey(identity: CanonicalRelationIdentity): string {
  return JSON.stringify(
    identity.namespace.map((segment) => [segment.role, segment.identifier.comparisonKey]),
  )
}

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

export function createPhysicalNameRegistry(
  profile: PhysicalNamingProfile,
): PhysicalNameRegistry {
  const names = new Map<string, { token: string; description: string }>()
  return {
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
