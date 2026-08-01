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

function createRegistryNode<T>(): RegistryNode<T> {
  return { children: new Map(), hasValue: false }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

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

function sqliteComparisonKey(spelling: string): string {
  let key = ''
  for (const character of spelling) {
    const code = character.charCodeAt(0)
    key += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : character
  }
  return key
}

function comparisonKey(adapter: RelationIdentityAdapter, spelling: string): string {
  return adapter === 'sqlite' ? sqliteComparisonKey(spelling) : spelling
}

function canonicalIdentifier(
  adapter: RelationIdentityAdapter,
  spelling: string,
  description: string,
): CanonicalIdentifier {
  assertIdentifier(spelling, description)
  return { spelling, comparisonKey: comparisonKey(adapter, spelling) }
}

function canonicalSegment(
  adapter: RelationIdentityAdapter,
  input: NamespaceIdentifierInput,
): CanonicalNamespaceSegment {
  return {
    role: input.role,
    identifier: canonicalIdentifier(adapter, input.spelling, `${input.role} identifier`),
  }
}

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

function resolveSqliteNamespace(
  selected: readonly NamespaceIdentifierInput[],
  writableDefault: readonly NamespaceIdentifierInput[],
): readonly NamespaceIdentifierInput[] {
  requireRoles(writableDefault, ['database'], 'SQLite writable default')
  requireRoles(selected, ['database'], 'SQLite relation namespace')
  return selected
}

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
 */
export function createCanonicalRelationIdentityModule(options: {
  adapter: RelationIdentityAdapter
  context: NamespaceContext
  registrationDefault?: readonly NamespaceIdentifierInput[]
}): CanonicalRelationIdentityModule {
  const { adapter, context, registrationDefault } = options

  const resolve = (input: RelationIdentityInput): CanonicalRelationIdentity => {
    const selected = input.namespace ?? registrationDefault ?? context.writableDefault
    const namespace =
      adapter === 'postgresql'
        ? resolvePostgresNamespace(selected, context.writableDefault)
        : resolveSqliteNamespace(selected, context.writableDefault)

    return {
      namespace: namespace.map((segment) => canonicalSegment(adapter, segment)),
      relation: canonicalIdentifier(adapter, input.relation, 'relation identifier'),
    }
  }

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

  const createRegistry = <T>(): CanonicalRelationRegistry<T> => {
    const root = createRegistryNode<T>()

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
      get(identity) {
        const node = find(identity, false)
        return node?.hasValue ? node.value : undefined
      },
      has(identity) {
        return find(identity, false)?.hasValue ?? false
      },
      set(identity, value) {
        const node = find(identity, true)!
        node.value = value
        node.hasValue = true
      },
    }
  }

  return {
    resolve,
    equals(left, right) {
      return compare(left, right) === 0
    },
    compare,
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
