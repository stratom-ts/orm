import type {
  NamespaceIdentifierInput,
  NamespaceRole,
  RelationIdentityInput,
} from '@/schemas/actions/relation'
import { InvariantError } from '@/utils/error'

export type {
  NamespaceIdentifierInput,
  NamespaceRole,
  RelationIdentityInput,
} from '@/schemas/actions/relation'

export type NamespaceContext = Readonly<{
  writableDefault: readonly NamespaceIdentifierInput[]
}>

export type CanonicalIdentifier = Readonly<{
  spelling: string
  comparisonKey: string
}>

export type CanonicalNamespaceSegment = Readonly<{
  role: NamespaceRole
  identifier: CanonicalIdentifier
}>

export type CanonicalRelationIdentity = Readonly<{
  namespace: readonly CanonicalNamespaceSegment[]
  relation: CanonicalIdentifier
}>

/** Low-level identity rules implemented by an individual dialect member. */
export type CanonicalRelationIdentityPolicy = Readonly<{
  id: string
  comparisonKey(spelling: string): string
  resolveNamespace(
    selected: readonly NamespaceIdentifierInput[],
    writableDefault: readonly NamespaceIdentifierInput[],
  ): readonly NamespaceIdentifierInput[]
}>

export type CanonicalRelationRegistry<T> = {
  get(identity: CanonicalRelationIdentity): T | undefined
  has(identity: CanonicalRelationIdentity): boolean
  set(identity: CanonicalRelationIdentity, value: T): void
}

export type CanonicalRelationIdentityModule = {
  resolveNamespace(
    namespace?: readonly NamespaceIdentifierInput[],
  ): readonly CanonicalNamespaceSegment[]
  resolve(input: RelationIdentityInput): CanonicalRelationIdentity
  member(role: 'column' | 'index' | 'namespace', spelling: string): CanonicalIdentifier
  equals(left: CanonicalRelationIdentity, right: CanonicalRelationIdentity): boolean
  compare(left: CanonicalRelationIdentity, right: CanonicalRelationIdentity): number
  format(
    identity: CanonicalRelationIdentity,
    member?: Readonly<{ role: 'column' | 'index'; spelling: string }>,
  ): string
  createRegistry<T>(): CanonicalRelationRegistry<T>
}

type RegistryNode<T> = {
  children: Map<NamespaceRole | 'relation', Map<string, RegistryNode<T>>>
  value?: T
  hasValue: boolean
}

/** Creates an empty canonical relation registry node. */
function createRegistryNode<T>(): RegistryNode<T> {
  return { children: new Map(), hasValue: false }
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
 * Validates identifier spelling before canonicalization.
 *
 * @param spelling - Authored identifier spelling.
 * @param description - Identifier description used in errors.
 */
function assertIdentifier(spelling: string, description: string): void {
  if (spelling.length === 0) {
    throw new InvariantError(`${description} must not be empty`)
  }

  if (spelling.includes('\0')) {
    throw new InvariantError(`${description} must not contain NUL`)
  }

  for (let index = 0; index < spelling.length; index++) {
    const codeUnit = spelling.charCodeAt(index)

    if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdfff &&
      !(
        codeUnit <= 0xdbff &&
        index + 1 < spelling.length &&
        spelling.charCodeAt(index + 1) >= 0xdc00 &&
        spelling.charCodeAt(index + 1) <= 0xdfff
      )
    ) {
      throw new InvariantError(
        `${description} must not contain unpaired Unicode surrogates`,
      )
    }

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) index++
  }
}

/**
 * Validates and canonicalizes an identifier.
 *
 * @param adapter - Relation identity adapter.
 * @param spelling - Authored identifier spelling.
 * @param description - Identifier description used in errors.
 */
function canonicalIdentifier(
  policy: CanonicalRelationIdentityPolicy,
  spelling: string,
  description: string,
): CanonicalIdentifier {
  assertIdentifier(spelling, description)
  return { spelling, comparisonKey: policy.comparisonKey(spelling) }
}

/**
 * Canonicalizes one namespace segment.
 *
 * @param adapter - Relation identity adapter.
 * @param input - Authored namespace segment.
 */
function canonicalSegment(
  policy: CanonicalRelationIdentityPolicy,
  input: NamespaceIdentifierInput,
): CanonicalNamespaceSegment {
  return {
    role: input.role,
    identifier: canonicalIdentifier(policy, input.spelling, `${input.role} identifier`),
  }
}

/**
 * Projects a canonical relation identity into ordered registry parts.
 *
 * @param identity - Canonical relation identity.
 */
function identityParts(
  identity: CanonicalRelationIdentity,
): readonly Readonly<{ role: NamespaceRole | 'relation'; comparisonKey: string }>[] {
  return [
    ...identity.namespace.map((segment) => ({
      role: segment.role,
      comparisonKey: segment.identifier.comparisonKey,
    })),
    { role: 'relation' as const, comparisonKey: identity.relation.comparisonKey },
  ]
}

/**
 * Creates the canonical relation identity module for one dialect and resolved
 * writable namespace context.
 *
 * @example
 *   const identities = createCanonicalRelationIdentityModule({
 *     policy,
 *     context: {
 *       writableDefault: [
 *         { role: 'database', spelling: 'app' },
 *         { role: 'schema', spelling: 'public' },
 *       ],
 *     },
 *   })
 *
 * @param options - Identity policy, writable context, and optional registration default.
 */
export function createCanonicalRelationIdentityModule(options: {
  policy: CanonicalRelationIdentityPolicy
  context: NamespaceContext
  registrationDefault?: readonly NamespaceIdentifierInput[]
}): CanonicalRelationIdentityModule {
  const { context, registrationDefault, policy } = options

  /**
   * Resolves an optional namespace against the configured defaults.
   *
   * @example
   *   identities.resolveNamespace([{ role: 'schema', spelling: 'public' }])
   *
   * @param input - Explicit namespace, or undefined to use configured defaults.
   */
  const resolveNamespace = (
    input?: readonly NamespaceIdentifierInput[],
  ): readonly CanonicalNamespaceSegment[] => {
    const selected =
      input && input.length > 0
        ? input
        : registrationDefault && registrationDefault.length > 0
          ? registrationDefault
          : context.writableDefault
    const namespace = policy.resolveNamespace(selected, context.writableDefault)

    return namespace.map((segment) => canonicalSegment(policy, segment))
  }

  /**
   * Resolves an authored relation identity into canonical form.
   *
   * @example
   *   identities.resolve({ relation: 'users' })
   *
   * @param input - Authored relation identity.
   */
  const resolve = (input: RelationIdentityInput): CanonicalRelationIdentity => {
    return {
      namespace: resolveNamespace(input.namespace),
      relation: canonicalIdentifier(policy, input.relation, 'relation identifier'),
    }
  }

  /**
   * Compares canonical identities by role and comparison key.
   *
   * @example
   *   identities.compare(left, right)
   *
   * @param left - First canonical identity.
   * @param right - Second canonical identity.
   */
  const compare = (
    left: CanonicalRelationIdentity,
    right: CanonicalRelationIdentity,
  ): number => {
    const length = Math.min(left.namespace.length, right.namespace.length)

    for (let index = 0; index < length; index++) {
      const leftSegment = left.namespace[index]!
      const rightSegment = right.namespace[index]!
      const role = compareCodeUnits(leftSegment.role, rightSegment.role)
      if (role !== 0) return role
      const identifier = compareCodeUnits(
        leftSegment.identifier.comparisonKey,
        rightSegment.identifier.comparisonKey,
      )
      if (identifier !== 0) return identifier
    }

    const namespaceLength = left.namespace.length - right.namespace.length
    if (namespaceLength !== 0) return namespaceLength
    return compareCodeUnits(left.relation.comparisonKey, right.relation.comparisonKey)
  }

  /**
   * Creates a registry keyed by canonical relation identity.
   *
   * @example
   *   const registry = identities.createRegistry<TableHandle>()
   */
  const createRegistry = <T>(): CanonicalRelationRegistry<T> => {
    const root = createRegistryNode<T>()

    /**
     * Finds a terminal registry node, optionally creating its path.
     *
     * @param identity - Canonical relation identity.
     * @param create - Whether missing nodes should be created.
     */
    const find = (identity: CanonicalRelationIdentity, create: boolean) => {
      let node = root

      for (const part of identityParts(identity)) {
        let byIdentifier = node.children.get(part.role)

        if (!byIdentifier) {
          if (!create) return undefined
          byIdentifier = new Map()
          node.children.set(part.role, byIdentifier)
        }

        let child = byIdentifier.get(part.comparisonKey)

        if (!child) {
          if (!create) return undefined
          child = createRegistryNode<T>()
          byIdentifier.set(part.comparisonKey, child)
        }

        node = child
      }

      return node
    }

    return {
      /**
       * Retrieves a registered value.
       *
       * @example
       *   registry.get(identity)
       *
       * @param identity - Canonical relation identity.
       */
      get(identity) {
        const node = find(identity, false)
        return node?.hasValue ? node.value : undefined
      },
      /**
       * Tests whether an identity has a registered value.
       *
       * @example
       *   registry.has(identity)
       *
       * @param identity - Canonical relation identity.
       */
      has(identity) {
        return find(identity, false)?.hasValue ?? false
      },
      /**
       * Associates a value with an identity.
       *
       * @example
       *   registry.set(identity, value)
       *
       * @param identity - Canonical relation identity.
       * @param value - Value to register.
       */
      set(identity, value) {
        const node = find(identity, true)!
        node.value = value
        node.hasValue = true
      },
    }
  }

  return {
    resolveNamespace,
    resolve,
    /**
     * Canonicalizes one identifier that is not itself a relation, such as a column,
     * index, or namespace name, so callers compare it under the adapter's rules.
     *
     * @example
     *   identities.member('column', 'email')
     *
     * @param role - Identifier role used in validation errors.
     * @param spelling - Authored identifier spelling.
     */
    member(role, spelling) {
      return canonicalIdentifier(policy, spelling, `${role} identifier`)
    },
    /**
     * Tests canonical relation identities for equality.
     *
     * @example
     *   identities.equals(left, right)
     *
     * @param left - First canonical identity.
     * @param right - Second canonical identity.
     */
    equals(left, right) {
      return compare(left, right) === 0
    },
    compare,
    /**
     * Formats a canonical identity and optional member for diagnostics.
     *
     * @example
     *   identities.format(identity, { role: 'column', spelling: 'id' })
     *
     * @param identity - Canonical relation identity.
     * @param member - Optional relation member.
     */
    format(identity, member) {
      const segments = identity.namespace.map(
        ({ role, identifier }) => `${role}:${JSON.stringify(identifier.spelling)}`,
      )
      segments.push(`relation:${JSON.stringify(identity.relation.spelling)}`)
      if (member) segments.push(`${member.role}:${JSON.stringify(member.spelling)}`)
      return `[${segments.join(', ')}]`
    },
    createRegistry,
  }
}
