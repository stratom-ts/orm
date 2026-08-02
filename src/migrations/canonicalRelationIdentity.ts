export type NamespaceRole = 'catalog' | 'database' | 'schema'

export type NamespaceIdentifierInput = Readonly<{
  role: NamespaceRole
  spelling: string
}>

export type RelationIdentityInput = Readonly<{
  namespace?: readonly NamespaceIdentifierInput[]
  relation: string
}>

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

export type RelationIdentityAdapter = 'postgresql' | 'sqlite'

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
    throw new TypeError(`${description} must not be empty`)
  }
  if (spelling.includes('\0')) {
    throw new TypeError(`${description} must not contain NUL`)
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
      throw new TypeError(`${description} must not contain unpaired Unicode surrogates`)
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) index++
  }
}

/**
 * Folds ASCII uppercase characters for SQLite identifier comparison.
 *
 * @param spelling - Authored identifier spelling.
 */
function sqliteComparisonKey(spelling: string): string {
  let key = ''
  for (const character of spelling) {
    const code = character.charCodeAt(0)
    key += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : character
  }
  return key
}

/**
 * Produces an adapter-specific identifier comparison key.
 *
 * @param adapter - Relation identity adapter.
 * @param spelling - Authored identifier spelling.
 */
function comparisonKey(adapter: RelationIdentityAdapter, spelling: string): string {
  return adapter === 'sqlite' ? sqliteComparisonKey(spelling) : spelling
}

/**
 * Validates and canonicalizes an identifier.
 *
 * @param adapter - Relation identity adapter.
 * @param spelling - Authored identifier spelling.
 * @param description - Identifier description used in errors.
 */
function canonicalIdentifier(
  adapter: RelationIdentityAdapter,
  spelling: string,
  description: string,
): CanonicalIdentifier {
  assertIdentifier(spelling, description)
  return { spelling, comparisonKey: comparisonKey(adapter, spelling) }
}

/**
 * Canonicalizes one namespace segment.
 *
 * @param adapter - Relation identity adapter.
 * @param input - Authored namespace segment.
 */
function canonicalSegment(
  adapter: RelationIdentityAdapter,
  input: NamespaceIdentifierInput,
): CanonicalNamespaceSegment {
  return {
    role: input.role,
    identifier: canonicalIdentifier(adapter, input.spelling, `${input.role} identifier`),
  }
}

/**
 * Asserts that namespace roles exactly match an ordered role list.
 *
 * @param namespace - Namespace segments to validate.
 * @param roles - Required ordered roles.
 * @param description - Namespace description used in errors.
 */
function requireRoles(
  namespace: readonly NamespaceIdentifierInput[],
  roles: readonly NamespaceRole[],
  description: string,
): void {
  if (
    namespace.length !== roles.length ||
    namespace.some((segment, index) => segment.role !== roles[index])
  ) {
    throw new TypeError(`${description} must have ordered roles ${roles.join(', ')}`)
  }
}

/**
 * Resolves and validates a PostgreSQL relation namespace.
 *
 * @param selected - Selected relation namespace.
 * @param writableDefault - Session writable namespace.
 */
function resolvePostgresNamespace(
  selected: readonly NamespaceIdentifierInput[],
  writableDefault: readonly NamespaceIdentifierInput[],
): readonly NamespaceIdentifierInput[] {
  requireRoles(writableDefault, ['database', 'schema'], 'PostgreSQL writable default')

  if (selected.length === 1 && selected[0]?.role === 'schema') {
    return [writableDefault[0]!, selected[0]]
  }
  requireRoles(selected, ['database', 'schema'], 'PostgreSQL relation namespace')

  if (selected[0]!.spelling !== writableDefault[0]!.spelling) {
    throw new TypeError('PostgreSQL relation database must match the writable database')
  }
  return selected
}

/**
 * Resolves and validates a SQLite fixture relation namespace.
 *
 * @param selected - Selected relation namespace.
 * @param writableDefault - Session writable namespace.
 */
function resolveSqliteNamespace(
  selected: readonly NamespaceIdentifierInput[],
  writableDefault: readonly NamespaceIdentifierInput[],
): readonly NamespaceIdentifierInput[] {
  requireRoles(writableDefault, ['database'], 'SQLite writable default')
  requireRoles(selected, ['database'], 'SQLite relation namespace')
  return selected
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
 *     adapter: 'postgresql',
 *     context: {
 *       writableDefault: [
 *         { role: 'database', spelling: 'app' },
 *         { role: 'schema', spelling: 'public' },
 *       ],
 *     },
 *   })
 *
 * @param options - Adapter, writable context, and optional registration default.
 */
export function createCanonicalRelationIdentityModule(options: {
  adapter: RelationIdentityAdapter
  context: NamespaceContext
  registrationDefault?: readonly NamespaceIdentifierInput[]
}): CanonicalRelationIdentityModule {
  const { adapter, context, registrationDefault } = options

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
    const namespace =
      adapter === 'postgresql'
        ? resolvePostgresNamespace(selected, context.writableDefault)
        : resolveSqliteNamespace(selected, context.writableDefault)

    return namespace.map((segment) => canonicalSegment(adapter, segment))
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
      relation: canonicalIdentifier(adapter, input.relation, 'relation identifier'),
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
