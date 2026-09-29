import { isTableHandle } from '@/defineTable'
import type { CatalogRequest } from '@/dialects/catalog'
import type { TableHandle } from '@/types'
import { InvariantError } from '@/utils/error'

import type {
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  NamespaceIdentifierInput,
  RelationIdentityInput,
} from './canonicalRelationIdentity'

export type MigrationRelationShape = 'complete' | 'additive'

export type MigrationOwnershipRelation = RelationIdentityInput | TableHandle

export type MigrationOwnershipDeclaration =
  | Readonly<{
      kind: 'relation'
      relation: MigrationOwnershipRelation
      shape: MigrationRelationShape
    }>
  | Readonly<{
      kind: 'absentRelation'
      relation: RelationIdentityInput
    }>
  | Readonly<{
      kind: 'completeNamespace'
      namespace?: readonly NamespaceIdentifierInput[]
    }>

export type ResolvedMigrationOwnership = {
  relationShape(identity: CanonicalRelationIdentity): MigrationRelationShape | undefined
  isAbsent(identity: CanonicalRelationIdentity): boolean
  ownsNamespace(namespace: readonly CanonicalNamespaceSegment[]): boolean
  readonly completeNamespaces: readonly (readonly CanonicalNamespaceSegment[])[]
  readonly explicitRelations: readonly CanonicalRelationIdentity[]
  readonly absentRelations: readonly CanonicalRelationIdentity[]
}

/**
 * Compares strings by locale-independent UTF-16 code-unit order.
 *
 * @param left - First string.
 * @param right - Second string.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1

  return 0
}

/**
 * Orders canonical namespaces by role and authored spelling.
 *
 * @param left - First canonical namespace.
 * @param right - Second canonical namespace.
 */
function compareNamespaceSpelling(
  left: readonly CanonicalNamespaceSegment[],
  right: readonly CanonicalNamespaceSegment[],
): number {
  const length = Math.min(left.length, right.length)

  for (let index = 0; index < length; index++) {
    const role = compareCodeUnits(left[index]!.role, right[index]!.role)

    if (role !== 0) return role

    const spelling = compareCodeUnits(
      left[index]!.identifier.spelling,
      right[index]!.identifier.spelling,
    )

    if (spelling !== 0) return spelling
  }

  return left.length - right.length
}

/**
 * Orders canonical identities by authored namespace and relation spelling.
 *
 * @param left - First canonical relation identity.
 * @param right - Second canonical relation identity.
 */
function compareIdentitySpelling(
  left: CanonicalRelationIdentity,
  right: CanonicalRelationIdentity,
): number {
  return (
    compareNamespaceSpelling(left.namespace, right.namespace) ||
    compareCodeUnits(left.relation.spelling, right.relation.spelling)
  )
}

/**
 * Projects a table handle into a relation identity input.
 *
 * @param handle - Registered table handle.
 */
function relationInput(handle: TableHandle): RelationIdentityInput {
  return handle.getTableMetadata().relation
}

/**
 * Builds the unresolved ownership scope consumed by a connector-session introspector.
 *
 * @example
 *   const request = createCatalogRequest(schemas, declarations)
 *
 * @param schemas - Registered table handles.
 * @param declarations - Explicit migration ownership declarations.
 * @param registrationDefault - Optional namespace for unqualified registrations.
 */
export function createCatalogRequest(
  schemas: readonly TableHandle[],
  declarations: readonly MigrationOwnershipDeclaration[],
  registrationDefault?: readonly NamespaceIdentifierInput[],
): CatalogRequest {
  // An explicit declaration overrides a registered handle's default complete shape.
  const relations: CatalogRequest['relations'][number][] = schemas.map((handle) => ({
    relation: relationInput(handle),
    shape: 'complete',
  }))
  const absentRelations: RelationIdentityInput[] = []
  const completeNamespaces: (readonly NamespaceIdentifierInput[])[] = []

  // resolveRequest canonicalizes duplicates with last-write-wins semantics.
  for (const declaration of declarations) {
    if (declaration.kind === 'completeNamespace') {
      completeNamespaces.push(declaration.namespace ?? [])
      continue
    }

    if (declaration.kind === 'absentRelation') {
      absentRelations.push(declaration.relation)
      continue
    }

    relations.push({
      relation: isTableHandle(declaration.relation)
        ? relationInput(declaration.relation)
        : declaration.relation,
      shape: declaration.shape,
    })
  }

  return {
    relations,
    absentRelations,
    completeNamespaces,
    ...(registrationDefault === undefined ? {} : { registrationDefault }),
  }
}

/**
 * Tests canonical namespaces for positional role and comparison-key equality.
 *
 * @param left - First canonical namespace.
 * @param right - Second canonical namespace.
 */
function sameNamespace(
  left: readonly CanonicalNamespaceSegment[],
  right: readonly CanonicalNamespaceSegment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right.at(index)!
      return (
        segment.role === other.role &&
        segment.identifier.comparisonKey === other.identifier.comparisonKey
      )
    })
  )
}

/**
 * Formats a canonical namespace for diagnostics.
 *
 * @param namespace - Canonical namespace segments.
 */
function formatNamespace(namespace: readonly CanonicalNamespaceSegment[]): string {
  return `[${namespace
    .map(({ role, identifier }) => `${role}:${JSON.stringify(identifier.spelling)}`)
    .join(', ')}]`
}

/**
 * Resolves migration authority once against canonical relation identities.
 *
 * @example
 *   const ownership = resolveMigrationOwnership(schemas, declarations, identities)
 *
 * @param schemas - Registered table handles.
 * @param declarations - Explicit migration ownership declarations.
 * @param identities - Canonical relation identity module.
 */
export function resolveMigrationOwnership(
  schemas: readonly TableHandle[],
  declarations: readonly MigrationOwnershipDeclaration[],
  identities: CanonicalRelationIdentityModule,
): ResolvedMigrationOwnership {
  const registered = identities.createRegistry<TableHandle>()
  const shapes = identities.createRegistry<MigrationRelationShape>()
  const explicitlyShaped = identities.createRegistry<true>()
  const absent = identities.createRegistry<true>()

  for (const handle of schemas) {
    const identity = identities.resolve(relationInput(handle))
    registered.set(identity, handle)
    shapes.set(identity, 'complete')
  }

  const resolvedRelations = declarations
    .filter(
      (
        declaration,
      ): declaration is Extract<
        MigrationOwnershipDeclaration,
        { kind: 'relation' | 'absentRelation' }
      > => declaration.kind !== 'completeNamespace',
    )
    .map((declaration) => {
      const input =
        declaration.kind === 'relation'
          ? isTableHandle(declaration.relation)
            ? relationInput(declaration.relation)
            : declaration.relation
          : declaration.relation
      return { declaration, identity: identities.resolve(input) }
    })
    .sort(
      (left, right) =>
        identities.compare(left.identity, right.identity) ||
        compareIdentitySpelling(left.identity, right.identity) ||
        (left.declaration.kind < right.declaration.kind
          ? -1
          : left.declaration.kind > right.declaration.kind
            ? 1
            : 0),
    )

  for (const { declaration, identity } of resolvedRelations) {
    if (declaration.kind === 'relation' && !registered.has(identity)) {
      throw new InvariantError(
        `Migration ownership for ${identities.format(identity)} requires a registered table handle`,
      )
    }

    if (declaration.kind === 'relation' && explicitlyShaped.has(identity)) {
      throw new InvariantError(
        `Duplicate migration ownership relation ${identities.format(identity)}`,
      )
    }

    if (declaration.kind === 'relation' && absent.has(identity)) {
      throw new InvariantError(
        `Contradictory present and absent migration ownership for ${identities.format(identity)}`,
      )
    }

    if (declaration.kind === 'relation') {
      explicitlyShaped.set(identity, true)
      shapes.set(identity, declaration.shape)
      continue
    }

    if (absent.has(identity)) {
      throw new InvariantError(
        `Duplicate absent-relation migration ownership for ${identities.format(identity)}`,
      )
    }

    if (registered.has(identity)) {
      throw new InvariantError(
        `Contradictory present and absent migration ownership for ${identities.format(identity)}`,
      )
    }

    absent.set(identity, true)
  }

  const completeNamespaces = declarations
    .filter(
      (
        declaration,
      ): declaration is Extract<
        MigrationOwnershipDeclaration,
        { kind: 'completeNamespace' }
      > => declaration.kind === 'completeNamespace',
    )
    .map((declaration) => identities.resolveNamespace(declaration.namespace))
    .sort((left, right) => {
      const leftIdentity: CanonicalRelationIdentity = {
        namespace: left,
        relation: { spelling: '', comparisonKey: '' },
      }
      const rightIdentity: CanonicalRelationIdentity = {
        namespace: right,
        relation: { spelling: '', comparisonKey: '' },
      }
      return (
        identities.compare(leftIdentity, rightIdentity) ||
        compareNamespaceSpelling(left, right)
      )
    })

  for (let index = 1; index < completeNamespaces.length; index++) {
    if (sameNamespace(completeNamespaces[index - 1]!, completeNamespaces[index]!)) {
      throw new InvariantError(
        `Duplicate complete-namespace migration ownership for ${formatNamespace(completeNamespaces[index]!)}`,
      )
    }
  }

  return {
    /**
     * Returns the managed shape for a relation, if present.
     *
     * @example
     *   ownership.relationShape(identity)
     *
     * @param identity - Canonical relation identity.
     */
    relationShape: (identity) => shapes.get(identity),
    /**
     * Tests whether a relation is declared absent.
     *
     * @example
     *   ownership.isAbsent(identity)
     *
     * @param identity - Canonical relation identity.
     */
    isAbsent: (identity) => absent.has(identity),
    /**
     * Tests whether a namespace is completely managed.
     *
     * @example
     *   ownership.ownsNamespace(identity.namespace)
     *
     * @param namespace - Canonical namespace segments.
     */
    ownsNamespace: (namespace) =>
      completeNamespaces.some((owned) => sameNamespace(owned, namespace)),
    completeNamespaces,
    explicitRelations: resolvedRelations
      .filter(({ declaration }) => declaration.kind === 'relation')
      .map(({ identity }) => identity),
    absentRelations: resolvedRelations
      .filter(({ declaration }) => declaration.kind === 'absentRelation')
      .map(({ identity }) => identity),
  }
}
