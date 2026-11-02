import type {
  NamespaceIdentifierInput,
  NamespaceRole,
  RelationIdentityInput,
} from '@/schemas/actions/relation'
import { SchemaError } from '@/utils/error'

type NamespaceContext = Readonly<{
  writableDefault: readonly NamespaceIdentifierInput[]
}>

type CanonicalIdentifier = Readonly<{
  spelling: string
  comparisonKey: string
}>

type CanonicalNamespaceSegment = Readonly<{
  role: NamespaceRole
  identifier: CanonicalIdentifier
}>

type CanonicalRelationIdentity = Readonly<{
  namespace: readonly CanonicalNamespaceSegment[]
  relation: CanonicalIdentifier
}>

/** Low-level identity rules implemented by an individual dialect member. */
type CanonicalRelationIdentityPolicy = Readonly<{
  id: string
  /**
   * Converts an identifier spelling into the selected policy's comparison key.
   *
   * @param spelling - Authored identifier spelling before canonicalization.
   *
   * @returns The policy-normalized key used for identifier equality.
   */
  comparisonKey(spelling: string): string
  /**
   * Resolves authored namespace segments using the configured writable defaults.
   *
   * @param selected - Authored namespace selected before applying writable defaults.
   * @param writableDefault - Writable namespace supplied by the native session.
   *
   * @returns Authored namespace segments using the configured writable defaults.
   */
  resolveNamespace(
    selected: readonly NamespaceIdentifierInput[],
    writableDefault: readonly NamespaceIdentifierInput[],
  ): readonly NamespaceIdentifierInput[]
}>

type CanonicalRelationRegistry<T> = {
  /**
   * Reads the value registered under one canonical relation identity.
   *
   * @param identity - Canonical relation or physical-session identity used by this
   *   operation.
   *
   * @returns The registered value or first result row, or null when none exists.
   */
  get(identity: CanonicalRelationIdentity): T | undefined
  /**
   * Tests whether a canonical relation identity has a registered value.
   *
   * @param identity - Canonical relation or physical-session identity used by this
   *   operation.
   *
   * @returns True when a canonical relation identity has a registered value.
   */
  has(identity: CanonicalRelationIdentity): boolean
  /**
   * Supplies the column patch for schema validation and update compilation.
   *
   * @param identity - Canonical relation or physical-session identity used by this
   *   operation.
   * @param value - Runtime value to validate, normalize, or map.
   */
  set(identity: CanonicalRelationIdentity, value: T): void
}

type CanonicalRelationIdentityModule = {
  /**
   * Resolves authored namespace segments using the configured writable defaults.
   *
   * @param namespace - Ordered role-tagged namespace segments used for identity
   *   resolution.
   *
   * @returns Authored namespace segments using the configured writable defaults.
   */
  resolveNamespace(
    namespace?: readonly NamespaceIdentifierInput[],
  ): readonly CanonicalNamespaceSegment[]
  /**
   * Resolves authored relation intent into role-tagged canonical identity.
   *
   * @param input - Relation identity input inputs and shared accumulators.
   *
   * @returns Authored relation intent into role-tagged canonical identity.
   */
  resolve(input: RelationIdentityInput): CanonicalRelationIdentity
  /**
   * Canonicalizes an authored relation-member spelling under the selected identity
   * policy.
   *
   * @param role - Identifier role used for canonicalization and diagnostics.
   * @param spelling - Authored identifier spelling before canonicalization.
   *
   * @returns The canonical identifier for the authored relation member.
   */
  member(role: 'column' | 'index' | 'namespace', spelling: string): CanonicalIdentifier
  /**
   * Tests canonical identities for positional role and comparison-key equality.
   *
   * @param left - Left operand or identity in the comparison.
   * @param right - Right operand or identity in the comparison.
   *
   * @returns True when canonical identities for positional role and comparison-key
   *   equality.
   */
  equals(left: CanonicalRelationIdentity, right: CanonicalRelationIdentity): boolean
  /**
   * Orders canonical identities using locale-independent code-unit comparisons.
   *
   * @param left - Left operand or identity in the comparison.
   * @param right - Right operand or identity in the comparison.
   *
   * @returns A negative, zero, or positive value under the operation's deterministic
   *   ordering rules.
   */
  compare(left: CanonicalRelationIdentity, right: CanonicalRelationIdentity): number
  /**
   * Formats canonical identity spellings for diagnostics without flattening their
   * structure.
   *
   * @param identity - Canonical relation or physical-session identity used by this
   *   operation.
   * @param member - Optional relation-member identity or contract adapter under
   *   evaluation.
   *
   * @returns The diagnostic identity spelling with structured namespace segments
   *   preserved.
   */
  format(
    identity: CanonicalRelationIdentity,
    member?: Readonly<{ role: 'column' | 'index'; spelling: string }>,
  ): string
  /**
   * Creates a registry that detects physical-name collisions in the selected uniqueness
   * scopes.
   *
   * @returns A registry that detects physical-name collisions in the selected uniqueness
   *   scopes.
   */
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
    throw new SchemaError({ message: `${description} must not be empty` })
  }

  if (spelling.includes('\0')) {
    throw new SchemaError({ message: `${description} must not contain NUL` })
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
      throw new SchemaError({
        message: `${description} must not contain unpaired Unicode surrogates`,
      })
    }

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) index++
  }
}

/**
 * Validates and canonicalizes an identifier.
 *
 * @param policy - Dialect identifier-comparison and namespace-resolution rules.
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
 * @param policy - Dialect identifier-comparison and namespace-resolution rules.
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
 * Creates a registry keyed by canonical relation identity.
 *
 * @example
 *   const registry = identities.createRegistry<TableHandle>()
 */
function createRegistry<T>(): CanonicalRelationRegistry<T> {
  const root = createRegistryNode<T>()
  /** Finds a relation registry node and optionally creates missing identity segments. */
  const find = (identity: CanonicalRelationIdentity, create: boolean) =>
    findRegistryNode(identity, create, root)

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
function createCanonicalRelationIdentityModule(options: {
  policy: CanonicalRelationIdentityPolicy
  context: NamespaceContext
  registrationDefault?: readonly NamespaceIdentifierInput[]
}): CanonicalRelationIdentityModule {
  const { context, registrationDefault, policy } = options
  /** Resolves authored namespace segments using the configured writable defaults. */
  const resolveNamespace = (input?: readonly NamespaceIdentifierInput[]) =>
    resolveCanonicalNamespace(input, registrationDefault, context, policy)

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

  const compare = compareIdentities

  return {
    resolveNamespace,
    resolve,
    ...createIdentityMembers(policy, compare),
    compare,
    format: formatIdentity,
    createRegistry,
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
function compareIdentities(
  left: CanonicalRelationIdentity,
  right: CanonicalRelationIdentity,
): number {
  const length = Math.min(left.namespace.length, right.namespace.length)

  for (let index = 0; index < length; index++) {
    const leftSegment = left.namespace[index]
    const rightSegment = right.namespace[index]
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
 * Formats canonical namespace, relation, and optional member spellings for diagnostics.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param member - Optional relation-member identity or contract adapter under evaluation.
 *
 * @returns A diagnostic identity spelling that keeps namespace and relation components
 *   distinct.
 */
function formatIdentity(
  identity: CanonicalRelationIdentity,
  member?: { role: string; spelling: string },
): string {
  const segments = identity.namespace.map(
    ({ role, identifier }) => `${role}:${JSON.stringify(identifier.spelling)}`,
  )

  segments.push(`relation:${JSON.stringify(identity.relation.spelling)}`)

  if (member) segments.push(`${member.role}:${JSON.stringify(member.spelling)}`)

  return `[${segments.join(', ')}]`
}

/**
 * Finds a terminal registry node, optionally creating its path.
 *
 * @param identity - Canonical relation identity.
 * @param create - Whether missing nodes should be created.
 */
function findRegistryNode<T>(
  identity: CanonicalRelationIdentity,
  create: boolean,
  root: ReturnType<typeof createRegistryNode<T>>,
) {
  let node = root

  for (const part of identityParts(identity)) {
    let byIdentifier = node.children.get(part.role)

    if (!byIdentifier && !create) return undefined

    if (!byIdentifier) {
      byIdentifier = new Map()
      node.children.set(part.role, byIdentifier)
    }

    let child = byIdentifier.get(part.comparisonKey)

    if (!child && !create) return undefined

    if (!child) {
      child = createRegistryNode<T>()
      byIdentifier.set(part.comparisonKey, child)
    }

    node = child
  }

  return node
}

/**
 * Binds member canonicalization and relation equality to the selected identity policy.
 *
 * @param policy - Dialect identifier-comparison and namespace-resolution rules.
 * @param compare - Canonical identity comparison used for equality and deterministic
 *   ordering.
 *
 * @returns Member canonicalization and equality operations bound to the selected identity
 *   policy.
 */
function createIdentityMembers(
  policy: CanonicalRelationIdentityPolicy,
  compare: CanonicalRelationIdentityModule['compare'],
): Pick<CanonicalRelationIdentityModule, 'member' | 'equals'> {
  return {
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
  }
}

/**
 * Uses explicit, registration, then session namespace defaults before canonicalization.
 *
 * @param input - Resolved inputs and accumulators for this operation.
 * @param registrationDefault - Explicit namespace default used before the session's
 *   writable default.
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 * @param policy - Dialect identifier-comparison and namespace-resolution rules.
 *
 * @returns Canonical namespace segments after explicit, registration, and
 *   writable-default resolution.
 */
function resolveCanonicalNamespace(
  input: readonly NamespaceIdentifierInput[] | undefined,
  registrationDefault:
    | readonly Readonly<{ role: NamespaceRole; spelling: string }>[]
    | undefined,
  context: Readonly<{ writableDefault: readonly NamespaceIdentifierInput[] }>,
  policy: Readonly<{
    id: string
    comparisonKey(spelling: string): string
    resolveNamespace(
      selected: readonly NamespaceIdentifierInput[],
      writableDefault: readonly NamespaceIdentifierInput[],
    ): readonly NamespaceIdentifierInput[]
  }>,
) {
  const selected =
    input && input.length > 0
      ? input
      : registrationDefault && registrationDefault.length > 0
        ? registrationDefault
        : context.writableDefault

  const namespace = policy.resolveNamespace(selected, context.writableDefault)

  return namespace.map((segment) => canonicalSegment(policy, segment))
}

export type {
  NamespaceIdentifierInput,
  NamespaceRole,
  RelationIdentityInput,
} from '@/schemas/actions/relation'

export type {
  NamespaceContext,
  CanonicalIdentifier,
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityPolicy,
  CanonicalRelationRegistry,
  CanonicalRelationIdentityModule,
}

export { createCanonicalRelationIdentityModule }
