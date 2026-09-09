import { SchemaError } from '@/utils/error'

/** Namespace roles understood by portable relation intent. */
export type NamespaceRole = 'catalog' | 'database' | 'schema'

/** One authored, role-tagged namespace segment. */
export type NamespaceIdentifierInput = Readonly<{
  role: NamespaceRole
  spelling: string
}>

/** Dialect-neutral authored relation intent. */
export type RelationIdentityInput = Readonly<{
  namespace?: readonly NamespaceIdentifierInput[]
  relation: string
}>

const NAMESPACE_ROLES = new Set<NamespaceRole>(['catalog', 'database', 'schema'])

/**
 * Validates portable relation structure. Dialect-specific namespace order and
 * supported roles are deliberately left to the selected identity member.
 */
export function validateRelationInput(input: RelationIdentityInput): void {
  if (typeof input.relation !== 'string' || input.relation.length === 0) {
    throw new SchemaError({ message: 'table relation must be a non-empty string' })
  }

  if (input.namespace === undefined) return

  if (!Array.isArray(input.namespace)) {
    throw new SchemaError({ message: 'table namespace must be an array' })
  }

  const roles = new Set<NamespaceRole>()

  for (const segment of input.namespace) {
    if (typeof segment !== 'object' || segment === null) {
      throw new SchemaError({ message: 'table namespace segments must be objects' })
    }

    if (!NAMESPACE_ROLES.has(segment.role)) {
      throw new SchemaError({
        message: `unsupported namespace role ${String(segment.role)}`,
      })
    }

    if (roles.has(segment.role)) {
      throw new SchemaError({ message: `duplicate namespace role ${segment.role}` })
    }

    if (typeof segment.spelling !== 'string' || segment.spelling.length === 0) {
      throw new SchemaError({
        message: `${segment.role} namespace spelling must be a non-empty string`,
      })
    }

    roles.add(segment.role)
  }
}

/** Creates a relation input while omitting an empty namespace property. */
export function createRelationInput(
  relation: string,
  namespace?: readonly NamespaceIdentifierInput[],
): RelationIdentityInput {
  const input = {
    relation,
    ...(namespace === undefined ? {} : { namespace }),
  } as RelationIdentityInput
  validateRelationInput(input)
  return input.namespace === undefined || input.namespace.length === 0
    ? { relation }
    : { namespace: [...input.namespace], relation }
}

/** Compares authored relation intent without flattening namespace identifiers. */
export function sameRelationInput(
  left: RelationIdentityInput,
  right: RelationIdentityInput,
): boolean {
  if (left.relation !== right.relation) return false

  const leftNamespace = left.namespace ?? []
  const rightNamespace = right.namespace ?? []
  return (
    leftNamespace.length === rightNamespace.length &&
    leftNamespace.every(
      (segment, index) =>
        segment.role === rightNamespace[index]?.role &&
        segment.spelling === rightNamespace[index]?.spelling,
    )
  )
}
