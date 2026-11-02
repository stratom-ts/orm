import type { Connector } from 'db0'

import type { MigrationSemanticProfile } from '@/ddl/migrationPlan'
import type { MigrationProgram } from '@/ddl/migrationProgram'
import type {
  CatalogFact,
  CatalogNamespace,
  CatalogRelation,
  CatalogRequest,
  CatalogSet,
  CatalogSnapshot,
} from '@/dialects/catalog'
import { compileColumnQuery } from '@/dialects/columnQuery'
import type {
  AuthoredDesiredSchema,
  Dialect,
  DialectQueryResolveOptions,
  OperationCommand,
  SelectAst,
  SqlAst,
} from '@/dialects/types'
import type { MigrationRelationShape } from '@/index'
import type {
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  CanonicalRelationIdentityPolicy,
  NamespaceContext,
  NamespaceIdentifierInput,
  NamespaceRole,
} from '@/migrations/canonicalRelationIdentity'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import {
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import type { PhysicalNamingProfile } from '@/migrations/physicalNaming'
import type {
  OperationSession,
  OperationSessionProvider,
} from '@/operations/operationSession'
import type { RelationIdentityInput } from '@/schemas'
import { physicalColumnName } from '@/schemas/physicalColumn'
import type { TableHandle } from '@/types'
import { InvariantError } from '@/utils/error'

/** Real db0 selector used only to prove the test member contract; not production support. */
const EXTENSION_CONTRACT_DIALECT_ID = 'mysql'
const EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON =
  'The contract fixture deliberately does not support migration execution'

type ExtensionContractCalls = {
  events: string[]
  operationCommands: OperationCommand[]
  compiledAst: SqlAst[]
  statements: { sql: string; params: readonly unknown[] }[]
  migrationOutcomes: ('applied' | 'unchanged')[]
  connector?: Connector
  catalog?: CatalogSnapshot
}

/** Creates the extension contract calls fixture used by the contract scenario. */
function createExtensionContractCalls(): ExtensionContractCalls {
  return {
    events: [],
    operationCommands: [],
    compiledAst: [],
    statements: [],
    migrationOutcomes: [],
  }
}

const identityPolicy: CanonicalRelationIdentityPolicy = {
  id: EXTENSION_CONTRACT_DIALECT_ID,
  /** Converts an identifier spelling into the selected policy's comparison key. */
  comparisonKey: (spelling) => spelling.toLowerCase(),
  /**
   * Resolves authored namespace segments using the configured writable defaults.
   *
   * @param selected - Authored namespace selected before applying writable defaults.
   * @param writableDefault - Writable namespace supplied by the native session.
   *
   * @returns Authored namespace segments using the configured writable defaults.
   */
  resolveNamespace(selected, writableDefault) {
    if (
      writableDefault.length !== 1 ||
      writableDefault[0]?.role !== 'database' ||
      selected.length !== 1 ||
      selected[0]?.role !== 'database'
    ) {
      throw new InvariantError(
        'Extension contract namespace must contain exactly one database segment',
      )
    }

    return selected
  },
}

const namingProfile: PhysicalNamingProfile = {
  id: EXTENSION_CONTRACT_DIALECT_ID,
  maximumLength: 96,
  lengthUnit: 'unicodeScalars',
  /** Converts an identifier spelling into the selected policy's comparison key. */
  comparisonKey: (name) => name.toLowerCase(),
  /** Selects the uniqueness scope used to reserve one kind of physical name. */
  scope: (kind) =>
    kind === 'foreignKey' || kind === 'check'
      ? 'relationConstraints'
      : 'namespaceRelations',
}

/**
 * Creates the identity fixture used by the contract scenario.
 *
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 *
 * @returns The identity fixture used by the contract scenario.
 */
function createIdentity(calls: ExtensionContractCalls) {
  return {
    id: EXTENSION_CONTRACT_DIALECT_ID,
    /** Binds canonical relation identity operations to the configured namespace context. */
    create(options: {
      context: NamespaceContext
      registrationDefault?: readonly NamespaceIdentifierInput[]
    }) {
      calls.events.push('identity.create')
      return createCanonicalRelationIdentityModule({ policy: identityPolicy, ...options })
    },
  }
}

/**
 * Creates the naming fixture used by the contract scenario.
 *
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 *
 * @returns The naming fixture used by the contract scenario.
 */
function createNaming(calls: ExtensionContractCalls) {
  return {
    /** Generates a deterministic physical name under the selected dialect's limits. */
    generate(seed: Parameters<typeof generatePhysicalName>[0]) {
      calls.events.push('naming.generate')
      return generatePhysicalName(seed, namingProfile)
    },
    /** Rejects physical identifiers that violate the selected dialect's naming rules. */
    validate(name: string, description: string) {
      calls.events.push('naming.validate')
      return validatePhysicalName(name, description, namingProfile)
    },
    /**
     * Creates a registry that detects physical-name collisions in the selected uniqueness
     * scopes.
     */
    createRegistry() {
      calls.events.push('naming.createRegistry')
      return createPhysicalNameRegistry(namingProfile)
    },
  }
}

/**
 * Resolves contract query relation for the current fixture scenario.
 *
 * @param relation - Authored or canonical relation addressed by this operation.
 * @param registrationDefault - Explicit namespace default used before the session's
 *   writable default.
 *
 * @returns Canonical database and table comparison keys for query matching.
 */
function resolveContractQueryRelation(
  relation: RelationIdentityInput,
  registrationDefault?: readonly NamespaceIdentifierInput[],
): {
  database: string
  table: string
} {
  if (relation.namespace === undefined || relation.namespace.length === 0) {
    const defaultNamespace = registrationDefault ?? [
      { role: 'database' as const, spelling: 'fixture_db' },
    ]

    if (
      defaultNamespace.length !== 1 ||
      defaultNamespace[0]?.role !== 'database' ||
      defaultNamespace[0].spelling.length === 0
    ) {
      throw new InvariantError(
        'Extension contract query registration default must provide one database segment',
      )
    }

    return {
      database: identityPolicy.comparisonKey(defaultNamespace[0].spelling),
      table: identityPolicy.comparisonKey(relation.relation),
    }
  }

  if (
    relation.namespace.length !== 1 ||
    relation.namespace[0]?.role !== 'database' ||
    relation.namespace[0].spelling.length === 0
  ) {
    throw new InvariantError(
      'Extension contract query relations must omit namespace or provide one database segment',
    )
  }

  return {
    database: identityPolicy.comparisonKey(relation.namespace[0].spelling),
    table: identityPolicy.comparisonKey(relation.relation),
  }
}

type ContractCompiledShape = Readonly<{
  database: string
  relation: string
  columns: readonly Readonly<{ output: string; physical: string }>[]
  parameterColumns: readonly string[]
}>

const CONTRACT_QUERY_PREFIX = 'fixture query:'

/** Compiles the fixture subset from the same case-folded/defaulted resolution. */
function compileContractQuery(
  node: SqlAst,
  registered: readonly TableHandle[],
  registrationDefault?: readonly NamespaceIdentifierInput[],
): { sql: string; params: readonly unknown[] } {
  if (node.kind !== 'select') {
    throw new InvariantError('Extension contract compiler only supports select queries')
  }

  validateContractSelectClauses(node)

  const relation = resolveContractQueryRelation(node.relation, registrationDefault)
  const relationMatches = findContractQueryRelationMatches(
    registered,
    node.relation,
    registrationDefault,
  )

  if (relationMatches.length !== 1) {
    throw new InvariantError('Extension contract compiler requires one resolved relation')
  }

  const handle = relationMatches[0]
  const selection = compileContractSelection(
    node,
    handle,
    registered,
    registrationDefault,
  )

  const { parameterColumns, params } = compileContractPredicate(
    node,
    registered,
    registrationDefault,
    handle,
  )

  const shape: ContractCompiledShape = {
    database: relation.database,
    relation: relation.table,
    columns: selection,
    parameterColumns,
  }

  return { sql: `${CONTRACT_QUERY_PREFIX}${JSON.stringify(shape)}`, params }
}

/**
 * Rejects clauses outside the extension fixture's supported select grammar.
 *
 * @param node - AST node or dependency-graph node being processed.
 */
function validateContractSelectClauses(node: SelectAst) {
  const hasUnsupportedClause =
    [node.joins?.length, node.orderBy?.length, node.groupBy?.length].some(Boolean) ||
    [node.having, node.limit, node.offset].some((clause) => clause !== undefined)

  if (hasUnsupportedClause) {
    throw new InvariantError(
      'Extension contract compiler only supports simple SELECT clauses',
    )
  }
}

/**
 * Compiles supported predicates using the extension fixture grammar.
 *
 * @param node - AST node or dependency-graph node being processed.
 * @param registered - Registered table handles indexed by canonical relation identity.
 * @param registrationDefault - Explicit namespace default used before the session's
 *   writable default.
 * @param handle - Table handle whose schema and relation metadata are required.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileContractPredicate(
  node: SelectAst,
  registered: readonly TableHandle[],
  registrationDefault:
    | readonly Readonly<{ role: NamespaceRole; spelling: string }>[]
    | undefined,
  handle: TableHandle,
) {
  const params: unknown[] = []
  const parameterColumns: string[] = []

  if (node.where !== undefined) {
    if (node.where.kind !== 'cmp' || node.where.right) {
      throw new InvariantError(
        'Extension contract compiler only supports one value predicate',
      )
    }

    const predicateHandle = node.where.relation
      ? findContractQueryRelationMatches(
          registered,
          node.where.relation,
          registrationDefault,
        )
      : [handle]

    const columnMatches =
      predicateHandle.length === 1
        ? findContractPhysicalColumnMatches(predicateHandle[0], node.where.column)
        : []

    if (columnMatches.length !== 1) {
      throw new InvariantError(
        'Extension contract compiler requires one resolved predicate column',
      )
    }

    parameterColumns.push(identityPolicy.comparisonKey(columnMatches[0]))

    if (node.where.value !== undefined) params.push(node.where.value)
  }

  return { parameterColumns, params }
}

/**
 * Compiles selected columns using the extension fixture's output aliases.
 *
 * @param node - AST node or dependency-graph node being processed.
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param registered - Registered table handles indexed by canonical relation identity.
 * @param registrationDefault - Explicit namespace default used before the session's
 *   writable default.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileContractSelection(
  node: SelectAst,
  handle: TableHandle,
  registered: readonly TableHandle[],
  registrationDefault:
    | readonly Readonly<{ role: NamespaceRole; spelling: string }>[]
    | undefined,
) {
  return node.selection.length === 1 && node.selection[0]?.kind === 'all'
    ? Object.keys(handle.getSchema().entries).map((column) => ({
        output: column,
        physical: identityPolicy.comparisonKey(column),
      }))
    : node.selection.map((item) => {
        if (item.kind !== 'column') {
          throw new InvariantError(
            'Extension contract compiler only supports column selections',
          )
        }

        const selectedHandle = item.relation
          ? findContractQueryRelationMatches(
              registered,
              item.relation,
              registrationDefault,
            )
          : [handle]

        const columnMatches =
          selectedHandle.length === 1
            ? findContractPhysicalColumnMatches(selectedHandle[0], item.column)
            : []

        if (columnMatches.length !== 1) {
          throw new InvariantError(
            'Extension contract compiler requires one resolved selected column',
          )
        }

        return {
          output: item.alias ?? item.column,
          physical: identityPolicy.comparisonKey(columnMatches[0]),
        }
      })
}

/**
 * Finds handles whose resolved relation identity matches the authored query relation.
 *
 * @param handles - Registered handles used for relation and column resolution.
 * @param relation - Authored or canonical relation addressed by this operation.
 * @param registrationDefault - Explicit namespace default used before the session's
 *   writable default.
 *
 * @returns Handles whose resolved relation identity matches the authored query relation.
 */
function findContractQueryRelationMatches(
  handles: readonly TableHandle[],
  relation: RelationIdentityInput,
  registrationDefault?: readonly NamespaceIdentifierInput[],
): readonly TableHandle[] {
  const expected = resolveContractQueryRelation(relation, registrationDefault)

  return handles.filter((handle) => {
    const candidate = resolveContractQueryRelation(
      handle.getTableMetadata().relation,
      registrationDefault,
    )

    return candidate.database === expected.database && candidate.table === expected.table
  })
}

/**
 * Finds authored column names equal under the extension identity policy.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param column - Authored column spelling to resolve, map, or compile.
 *
 * @returns Authored column names equal under the extension identity policy.
 */
function findContractQueryColumnMatches(
  handle: TableHandle,
  column: string,
): readonly string[] {
  return Object.keys(handle.getSchema().entries).filter((property) => property === column)
}

/** Matches already-resolved storage names in the compiler's separate lookup domain. */
function findContractPhysicalColumnMatches(
  handle: TableHandle,
  column: string,
): readonly string[] {
  return Object.keys(handle.getSchema().entries)
    .map((property) => physicalColumnName(handle, property))
    .filter(
      (name) =>
        identityPolicy.comparisonKey(name) === identityPolicy.comparisonKey(column),
    )
}

/**
 * Lowers authored storage and references into the extension fixture's desired schema.
 *
 * @param graph - Registered authored tables and their resolved reference graph.
 *
 * @returns Desired tables with fixture storage types, keys, and resolved references.
 */
function lowerSchema(graph: AuthoredDesiredSchema) {
  return {
    tables: graph.tables.map((table) => ({
      identity: table.identity,
      columns: table.columns.map((column) => ({
        identifier: column.identifier,
        dataType:
          column.metadata?.physicalType?.[EXTENSION_CONTRACT_DIALECT_ID] ??
          'fixture_text',
        notNull: true,
        unique: column.metadata?.unique ?? false,
        autoIncrement: false,
        ...(column.reference === undefined
          ? {}
          : {
              reference: {
                relation: column.reference.targetRelation,
                column: column.reference.targetColumn,
                ...(column.reference.metadata.onDelete === undefined
                  ? {}
                  : { onDelete: column.reference.metadata.onDelete }),
                ...(column.reference.metadata.onUpdate === undefined
                  ? {}
                  : { onUpdate: column.reference.metadata.onUpdate }),
              },
            }),
      })),
      primaryKey: (Array.isArray(table.metadata.primaryKey)
        ? table.metadata.primaryKey
        : [table.metadata.primaryKey]
      ).map((name) => table.columns.find((column) => column.name === name)!.identifier),
    })),
  }
}

/**
 * Resolves catalog ownership scope under the fixture's namespace defaults.
 *
 * @param request - Requested relations, declared absences, and completely owned
 *   namespaces.
 * @param namespaceContext - Native writable namespace defaults used for identity
 *   resolution.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 *
 * @returns Canonical requested relations, declared absences, and complete namespaces.
 */
function resolvedRequest(
  request: CatalogRequest,
  namespaceContext: NamespaceContext,
  identity: ReturnType<typeof createIdentity>,
) {
  const identities = identity.create({
    context: namespaceContext,
    ...(request.registrationDefault === undefined
      ? {}
      : { registrationDefault: request.registrationDefault }),
  })

  return {
    relations: request.relations.map((relation) => ({
      identity: identities.resolve(relation.relation),
      shape: relation.shape,
    })),
    absentRelations: request.absentRelations.map((relation) =>
      identities.resolve(relation),
    ),
    completeNamespaces: request.completeNamespaces.map((namespace) =>
      identities.resolveNamespace(namespace),
    ),
  }
}

/** Reports whether two resolved namespace targets name the same namespace. */
function sameNamespace(
  left: readonly CanonicalNamespaceSegment[],
  right: readonly CanonicalNamespaceSegment[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (segment, index) =>
        segment.role === right[index]?.role &&
        segment.identifier.comparisonKey === right[index]?.identifier.comparisonKey,
    )
  )
}

type ExtensionCatalogRow =
  | Readonly<{
      kind: 'namespace'
      namespace: readonly NamespaceIdentifierInput[]
    }>
  | Readonly<{
      kind: 'relation'
      namespace?: readonly NamespaceIdentifierInput[]
      relation: string
    }>

/** Checks for a non-null object value excluding arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks for non-empty role-tagged namespace segments with valid spellings.
 *
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns True for non-empty namespace segments with valid roles and spellings.
 */
function isNamespaceInput(value: unknown): value is readonly NamespaceIdentifierInput[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (segment) =>
        isRecord(segment) &&
        (segment.role === 'catalog' ||
          segment.role === 'database' ||
          segment.role === 'schema') &&
        typeof segment.spelling === 'string' &&
        segment.spelling.length > 0,
    )
  )
}

/**
 * Validates native fixture rows before catalog identity resolution.
 *
 * @param rows - Ordered native observations or result rows to process.
 *
 * @returns Validated namespace and relation rows; malformed observations throw.
 */
function parseExtensionCatalogRows(
  rows: readonly unknown[],
): readonly ExtensionCatalogRow[] {
  return rows.map((row, index) => {
    if (!isRecord(row) || (row.kind !== 'namespace' && row.kind !== 'relation')) {
      throw new InvariantError(
        `Extension contract catalog fixture row ${index} must use kind 'namespace' or 'relation'`,
      )
    }

    if (row.kind === 'namespace') {
      if (!isNamespaceInput(row.namespace)) {
        throw new InvariantError(
          `Extension contract catalog fixture row ${index} must provide valid namespace role/spelling segments`,
        )
      }

      return { kind: row.kind, namespace: row.namespace }
    }

    if (row.namespace !== undefined && !isNamespaceInput(row.namespace)) {
      throw new InvariantError(
        `Extension contract catalog fixture row ${index} must provide valid namespace role/spelling segments when namespace is present`,
      )
    }

    if (typeof row.relation !== 'string' || row.relation.length === 0) {
      throw new InvariantError(
        `Extension contract catalog fixture row ${index} must provide a non-empty relation spelling`,
      )
    }

    return {
      kind: row.kind,
      ...(row.namespace === undefined ? {} : { namespace: row.namespace }),
      relation: row.relation,
    }
  })
}

/**
 * Creates the catalog fixture used by the contract scenario.
 *
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 *
 * @returns The catalog fixture used by the contract scenario.
 */
function createCatalog(
  calls: ExtensionContractCalls,
  identity: ReturnType<typeof createIdentity>,
) {
  const namespaceContext: NamespaceContext = {
    writableDefault: [{ role: 'database', spelling: 'fixture_db' }],
  }

  return {
    /**
     * Reads the requested native catalog scope and returns its portable evidence
     * snapshot.
     */
    introspectCatalog: (
      executor: {
        execute(query: { sql: string; params: readonly unknown[] }): Promise<unknown[]>
      },
      request: CatalogRequest,
    ) => introspectExtensionCatalog(executor, request, calls, namespaceContext, identity),
  }
}

/**
 * Creates the connector's provider for exclusive native operation sessions.
 *
 * @param connector - Connector that owns native connection resources.
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 *
 * @returns The connector's provider for exclusive native operation sessions.
 */
function createSessionProvider(
  connector: Connector,
  calls: ExtensionContractCalls,
): OperationSessionProvider {
  calls.connector = connector
  calls.events.push('operations.createSessionProvider')
  let nextSession = 1

  return {
    nativeTransactions: true,
    /** Opens an exclusive fixture session with lifecycle controls. */
    async open(): Promise<OperationSession> {
      calls.events.push('session.open')
      const physicalSession = `fixture-session-${nextSession++}`
      return {
        identity: { database: 'fixture_db', physicalSession },
        /** Runs fixture SQL and records physical-session ownership. */
        query: (query) => executeExtensionSessionQuery(query, calls),
        /** Runs a fixture statement with configured outcomes. */
        async run(query) {
          calls.statements.push(query)
          calls.events.push('session.run')
        },
        /** Cancels the active physical-session operation. */
        async cancel() {
          calls.events.push('session.cancel')
        },
        /** Releases the fixture lease with configured cleanup behavior. */
        async release(disposition) {
          calls.events.push(`session.release:${disposition}`)
        },
      }
    },
    /** Closes the fixture provider after its leases settle. */
    async close() {
      calls.events.push('sessionProvider.close')
      await connector.dispose?.()
    },
  }
}

/**
 * Compares explicit namespace inputs after canonical resolution.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 * @param left - Left operand or identity in the comparison.
 * @param right - Right operand or identity in the comparison.
 *
 * @returns True when both namespace inputs resolve to equal canonical segments.
 */
function sameNamespaceInput(
  identity: ReturnType<typeof createIdentity>,
  context: NamespaceContext,
  left: readonly NamespaceIdentifierInput[] | undefined,
  right: readonly NamespaceIdentifierInput[] | undefined,
): boolean {
  /** Resolves a namespace, retaining omitted and invalid inputs distinctly. */
  const resolve = (input: readonly NamespaceIdentifierInput[] | undefined) => {
    if (!input?.length) return undefined

    try {
      return identity.create({ context }).resolveNamespace(input)
    } catch {
      return null
    }
  }

  const selected = resolve(left)
  const expected = resolve(right)

  if (selected == null || expected == null) {
    return selected === undefined && expected === undefined
  }

  return sameNamespace(selected, expected)
}

/**
 * Collects semantic-profile differences as deterministic lowering diagnostics.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param planned - Migration Plan with its resolved Semantic Profile and desired-schema
 *   registrations.
 * @param expected - Expected profile, evidence, or result used by the current check.
 *
 * @returns Semantic-profile differences as deterministic lowering diagnostics.
 */
function profileIssues(
  identity: ReturnType<typeof createIdentity>,
  planned: MigrationSemanticProfile,
  expected: MigrationSemanticProfile,
) {
  const issues: {
    code: 'profile_mismatch'
    message: string
    sourceStepIndexes: readonly number[]
  }[] = []

  /** Adds a selected output column while rejecting duplicate output names. */
  const add = (message: string) =>
    issues.push({ code: 'profile_mismatch', message, sourceStepIndexes: [] })

  if (planned.identityAdapter !== expected.identityAdapter) {
    add('Contract fixture identity adapter does not match the executing profile')
  }

  if (expected.identityAdapter !== identity.id) {
    add('Executing identity adapter does not select the contract fixture')
  }

  if (
    !sameNamespaceInput(
      identity,
      expected.namespaceContext,
      planned.namespaceContext.writableDefault,
      expected.namespaceContext.writableDefault,
    )
  ) {
    add('Contract fixture writable namespace context does not match')
  }

  if (
    !sameNamespaceInput(
      identity,
      expected.namespaceContext,
      planned.registrationDefault,
      expected.registrationDefault,
    )
  ) {
    add('Contract fixture registration default does not match')
  }

  return issues
}

/**
 * Creates the extension contract dialect fixture used by the contract scenario.
 *
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns The extension contract dialect fixture used by the contract scenario.
 */
function createExtensionContractDialect(
  calls: ExtensionContractCalls,
  options?: Readonly<{ migration?: 'supported' | 'unsupported' }>,
): Dialect {
  const identity = createIdentity(calls)
  const naming = createNaming(calls)
  const catalog = createCatalog(calls, identity)
  const schema = createExtensionSchemaFacet(calls)
  const query = createContractQueryFacet(calls)

  return {
    id: EXTENSION_CONTRACT_DIALECT_ID,
    classifyDriverError: () => ({ kind: 'unknown', retryable: false }),
    identity,
    naming,
    schema,
    query,
    catalog,
    operations: {
      /** Creates the connector's provider for exclusive native operation sessions. */
      createSessionProvider: (connector) => createSessionProvider(connector, calls),
      /** Compiles the current query or command into SQL and ordered bound parameters. */
      compile(command) {
        calls.events.push(`operations.compile:${command.kind}`)
        calls.operationCommands.push(command)
        return {
          sql:
            'id' in command
              ? `fixture operation ${command.kind} ${command.id}`
              : `fixture operation ${command.kind}`,
          params: [],
        }
      },
    },
    migration: {
      planning: { identity, naming, schema },
      catalog,
      /** Lowers for the current fixture scenario. */
      lower: (planned, expectedProfile) =>
        lowerExtensionMigration(planned, expectedProfile, calls, identity, options),
      /** Executes fixture SQL with the configured native observations. */
      execute: (options) => executeExtensionMigration(options, calls),
    },
  }
}

/**
 * Creates the extension schema facet fixture used by the contract scenario.
 *
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 *
 * @returns The extension schema facet fixture used by the contract scenario.
 */
function createExtensionSchemaFacet(calls: ExtensionContractCalls) {
  return {
    /**
     * Resolves authored column storage into the selected dialect's desired-schema
     * representation.
     */
    lowerDesiredSchema(graph: AuthoredDesiredSchema) {
      calls.events.push('schema.lowerDesiredSchema')
      return lowerSchema(graph)
    },
    /** Infers a supported physical SQL type from Valibot schema facts. */
    inferColumnType() {
      calls.events.push('schema.inferColumnType')
      return 'fixture_text'
    },
    /** Normalizes physical SQL type spelling for stable schema comparison. */
    normalizeDataType(dataType: string) {
      return dataType.toLowerCase()
    },
  }
}

/**
 * Creates the contract query facet fixture used by the contract scenario.
 *
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 *
 * @returns The contract query facet fixture used by the contract scenario.
 */
function createContractQueryFacet(calls: ExtensionContractCalls) {
  return {
    /** Binds query compilation and matching to the registered table handles. */
    resolve(registered: readonly TableHandle[], options?: DialectQueryResolveOptions) {
      calls.events.push('query.resolve')
      const resolved = {
        /** Compiles the current query or command into SQL and ordered bound parameters. */
        compile(node: SqlAst) {
          calls.events.push('query.compile')
          calls.compiledAst.push(node)
          return compileContractQuery(node, registered, options?.registrationDefault)
        },
        /** Finds handles matching the authored relation under query rules. */
        findRelationMatches(
          relation: RelationIdentityInput,
          handles: readonly TableHandle[] = registered,
        ) {
          calls.events.push('query.findRelationMatches')
          return findContractQueryRelationMatches(
            handles,
            relation,
            options?.registrationDefault,
          )
        },
        /** Finds column names equal under the selected query rules. */
        findColumnMatches(handle: TableHandle, column: string) {
          calls.events.push('query.findColumnMatches')
          return findContractQueryColumnMatches(handle, column)
        },
      }

      return {
        ...resolved,
        compile: (node: SqlAst) => compileColumnQuery(resolved, node),
      }
    },
    /** Maps an authored value to its physical SQL parameter representation. */
    mapParamValue(_dataType: string, value: unknown) {
      calls.events.push('query.mapParamValue')
      return `fixture-param:${String(value)}`
    },
    /** Decodes a native result value using the selected mapping rules. */
    mapResultValue(_dataType: string, value: unknown) {
      calls.events.push('query.mapResultValue')
      return `fixture-result:${String(value)}`
    },
  }
}

/**
 * Builds introspect extension catalog evidence for schema reconciliation checks.
 *
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param request - Requested relations, declared absences, and completely owned
 *   namespaces.
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 * @param namespaceContext - Native writable namespace defaults used for identity
 *   resolution.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 *
 * @returns Introspect extension catalog evidence for schema reconciliation checks.
 */
async function introspectExtensionCatalog(
  executor: {
    execute(query: { sql: string; params: readonly unknown[] }): Promise<unknown[]>
  },
  request: CatalogRequest,
  calls: ExtensionContractCalls,
  namespaceContext: Readonly<{ writableDefault: readonly NamespaceIdentifierInput[] }>,
  identity: ReturnType<typeof createIdentity>,
): Promise<CatalogSnapshot> {
  calls.events.push('catalog.introspect')
  const rows = parseExtensionCatalogRows(
    await executor.execute({
      sql: 'fixture catalog snapshot',
      params: [],
    }),
  )

  const unsupported = {
    state: 'unsupported' as const,
    by: 'engine' as const,
    reason: 'The contract fixture deliberately has no identity generation',
  }

  const requestEvidence = resolvedRequest(request, namespaceContext, identity)
  const identities = identity.create({
    context: namespaceContext,
    ...(request.registrationDefault === undefined
      ? {}
      : { registrationDefault: request.registrationDefault }),
  })

  const namespaces: CatalogNamespace[] = decodeExtensionNamespaces(
    requestEvidence,
    rows,
    identities,
    unsupported,
  )

  appendExtensionRelations(rows, identities, requestEvidence, namespaces, unsupported)

  return assembleExtensionCatalog(
    requestEvidence,
    unsupported,
    namespaceContext,
    namespaces,
    calls,
  )
}

/**
 * Builds assemble extension catalog evidence for schema reconciliation checks.
 *
 * @param requestEvidence - Resolved requested relation and namespace scope.
 * @param unsupported - Explicit unsupported evidence retained instead of inventing native
 *   facts.
 * @param namespaceContext - Native writable namespace defaults used for identity
 *   resolution.
 * @param namespaces - Observed namespace evidence, including relation coverage.
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 *
 * @returns Assemble extension catalog evidence for schema reconciliation checks.
 */
function assembleExtensionCatalog(
  requestEvidence: {
    relations: { identity: CanonicalRelationIdentity; shape: MigrationRelationShape }[]
    absentRelations: CanonicalRelationIdentity[]
    completeNamespaces: (readonly CanonicalNamespaceSegment[])[]
  },
  unsupported: { state: 'unsupported'; by: 'engine'; reason: string },
  namespaceContext: Readonly<{ writableDefault: readonly NamespaceIdentifierInput[] }>,
  namespaces: Readonly<{
    identity: readonly CanonicalNamespaceSegment[]
    owner: CatalogFact<string>
    relations: CatalogSet<CatalogRelation>
  }>[],
  calls: ExtensionContractCalls,
) {
  const catalog: CatalogSnapshot = {
    source: { dialect: EXTENSION_CONTRACT_DIALECT_ID, version: 'contract' },
    request: requestEvidence,
    capabilities: {
      namespaces: { state: 'supported', fidelity: 'portable' },
      relationOwner: unsupported,
      identity: unsupported,
      richObjects: unsupported,
    },
    namespaceContext,
    namespaces: { items: namespaces, coverage: { state: 'complete' } },
    nameReservations: { items: [], coverage: { state: 'complete' } },
    constraintNameReservations: { items: [], coverage: { state: 'complete' } },
    diagnostics: [],
  }

  calls.catalog = catalog
  return catalog
}

/**
 * Builds extension namespace coverage from requested identities and native fixture rows.
 *
 * @param requestEvidence - Resolved requested relation and namespace scope.
 * @param rows - Ordered native observations or result rows to process.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param unsupported - Explicit unsupported evidence retained instead of inventing native
 *   facts.
 *
 * @returns Extension namespace coverage from requested identities and native fixture
 *   rows.
 */
function decodeExtensionNamespaces(
  requestEvidence: ReturnType<typeof resolvedRequest>,
  rows: readonly ExtensionCatalogRow[],
  identities: CanonicalRelationIdentityModule,
  unsupported: { state: 'unsupported'; by: 'engine'; reason: string },
) {
  const requestedNamespaces = [
    ...requestEvidence.relations.map(({ identity }) => identity.namespace),
    ...requestEvidence.absentRelations.map((identity) => identity.namespace),
    ...requestEvidence.completeNamespaces,
  ]

  const namespaces: CatalogNamespace[] = []

  for (const row of rows) {
    if (row.kind !== 'namespace') continue

    const namespace = identities.resolveNamespace(row.namespace)

    if (!requestedNamespaces.some((requested) => sameNamespace(requested, namespace))) {
      continue
    }

    if (namespaces.some((candidate) => sameNamespace(candidate.identity, namespace))) {
      throw new InvariantError('Duplicate extension contract namespace row')
    }

    namespaces.push({
      identity: namespace,
      owner: unsupported,
      relations: {
        items: [],
        coverage: requestEvidence.completeNamespaces.some((requested) =>
          sameNamespace(requested, namespace),
        )
          ? { state: 'complete' }
          : {
              state: 'partial',
              remainder: {
                state: 'unmanaged',
                reason: 'Relations outside the requested catalog scope are unmanaged',
              },
            },
      },
    })
  }

  return namespaces
}

/**
 * Adds observed extension relations to their matching namespace evidence.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param requestEvidence - Resolved requested relation and namespace scope.
 * @param namespaces - Observed namespace evidence, including relation coverage.
 * @param unsupported - Explicit unsupported evidence retained instead of inventing native
 *   facts.
 */
function appendExtensionRelations(
  rows: readonly ExtensionCatalogRow[],
  identities: CanonicalRelationIdentityModule,
  requestEvidence: ReturnType<typeof resolvedRequest>,
  namespaces: Readonly<{
    identity: readonly CanonicalNamespaceSegment[]
    owner: CatalogFact<string>
    relations: CatalogSet<CatalogRelation>
  }>[],
  unsupported: { state: 'unsupported'; by: 'engine'; reason: string },
) {
  for (const row of rows) {
    if (row.kind !== 'relation') continue

    const relation = identities.resolve({
      ...(row.namespace === undefined ? {} : { namespace: row.namespace }),
      relation: row.relation,
    })

    const requested =
      requestEvidence.relations.some(({ identity }) =>
        identities.equals(identity, relation),
      ) ||
      requestEvidence.absentRelations.some((identity) =>
        identities.equals(identity, relation),
      ) ||
      requestEvidence.completeNamespaces.some((namespace) =>
        sameNamespace(namespace, relation.namespace),
      )

    if (!requested) continue

    appendExtensionRelation(namespaces, relation, unsupported)
  }
}

/**
 * Adds one relation when its canonical namespace exists in the collected evidence.
 *
 * @param namespaces - Observed namespace evidence, including relation coverage.
 * @param relation - Authored or canonical relation addressed by this operation.
 * @param unsupported - Explicit unsupported evidence retained instead of inventing native
 *   facts.
 */
function appendExtensionRelation(
  namespaces: Readonly<{
    identity: readonly CanonicalNamespaceSegment[]
    owner: CatalogFact<string>
    relations: CatalogSet<CatalogRelation>
  }>[],
  relation: CanonicalRelationIdentity,
  unsupported: { state: 'unsupported'; by: 'engine'; reason: string },
) {
  const namespaceIndex = namespaces.findIndex((candidate) =>
    sameNamespace(candidate.identity, relation.namespace),
  )

  if (namespaceIndex < 0) {
    throw new InvariantError(
      'Extension contract relation row requires an observed namespace row',
    )
  }

  const catalogRelation = {
    identity: relation,
    kind: 'table' as const,
    persistence: 'permanent' as const,
    owner: unsupported,
    management: 'managed' as const,
    nativeDefinition: unsupported,
    table: unsupported,
  }

  const namespace = namespaces[namespaceIndex]
  namespaces[namespaceIndex] = {
    ...namespace,
    relations: {
      ...namespace.relations,
      items: [...namespace.relations.items, catalogRelation],
    },
  }
}

/**
 * Lowers a compatible plan or returns explicit profile and capability diagnostics.
 *
 * @param planned - Migration Plan with its resolved Semantic Profile and desired-schema
 *   registrations.
 * @param expectedProfile - Semantic Profile required by the executing migration session.
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A statement-atomic physical program or explicit lowering diagnostics.
 */
function lowerExtensionMigration(
  planned: Parameters<Dialect['migration']['lower']>[0],
  expectedProfile: Parameters<Dialect['migration']['lower']>[1],
  calls: ExtensionContractCalls,
  identity: {
    id: string
    create(options: {
      context: NamespaceContext
      registrationDefault?: readonly NamespaceIdentifierInput[]
    }): CanonicalRelationIdentityModule
  },
  options: Readonly<{ migration?: 'supported' | 'unsupported' }> | undefined,
): ReturnType<Dialect['migration']['lower']> {
  calls.events.push('migration.lower')
  const mismatches = profileIssues(identity, planned.profile, expectedProfile)

  if (mismatches.length > 0) return { issues: mismatches }

  if (options?.migration === 'unsupported') {
    return {
      issues: [
        {
          code: 'compile_failure',
          message: EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON,
          sourceStepIndexes: planned.plan.steps.map((_step, index) => index),
        },
      ],
    }
  }

  const actions: MigrationProgram['actions'] = planned.plan.steps.map((step, index) => ({
    sourceStepIndexes: [index],
    transaction: 'allowed',
    statements: [{ sql: `fixture migration ${step.kind} ${index}`, params: [] }],
  }))

  return {
    program: { atomicity: 'statement-atomic', preconditions: [], actions },
  }
}

/**
 * Executes lowered fixture actions while recording their acknowledged outcome.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 *
 * @returns The acknowledged outcome after executing the fixture migration actions.
 */
async function executeExtensionMigration(
  options: Parameters<Dialect['migration']['execute']>[0],
  calls: ExtensionContractCalls,
): ReturnType<Dialect['migration']['execute']> {
  calls.events.push('migration.execute')
  const program = await options.prepare()
  calls.events.push('migration.prepared')

  for (const action of program.actions) {
    for (const statement of action.statements) await options.executor.run(statement)
  }

  const outcome = program.actions.length === 0 ? 'unchanged' : 'applied'
  calls.migrationOutcomes.push(outcome)
  return { outcome }
}

/**
 * Decodes fixture query SQL and returns selected values with configured mappings.
 *
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 *
 * @returns Fixture query rows shaped to match the compiled selection and bindings.
 */
async function executeExtensionSessionQuery(
  query: Parameters<OperationSession['query']>[0],
  calls: ExtensionContractCalls,
) {
  calls.statements.push(query)
  calls.events.push('session.query')

  if (!query.sql.startsWith(CONTRACT_QUERY_PREFIX)) return []

  const shape = JSON.parse(
    query.sql.slice(CONTRACT_QUERY_PREFIX.length),
  ) as ContractCompiledShape

  return [
    Object.fromEntries(
      shape.columns.map(({ output, physical }) => {
        const parameterIndex = shape.parameterColumns.indexOf(physical)
        const source = parameterIndex < 0 ? 'row-1' : String(query.params[parameterIndex])
        return [output, `${shape.database}.${shape.relation}.${physical}:${source}`]
      }),
    ),
  ]
}

export type { ExtensionContractCalls }

export {
  EXTENSION_CONTRACT_DIALECT_ID,
  EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON,
  createExtensionContractCalls,
  createExtensionContractDialect,
}
