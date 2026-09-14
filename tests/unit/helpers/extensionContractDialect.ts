import type { Connector } from 'db0'

import type { MigrationSemanticProfile } from '@/ddl/migrationPlan'
import type { MigrationProgram } from '@/ddl/migrationProgram'
import type { CatalogRequest, CatalogSnapshot } from '@/dialects/catalog'
import type {
  AuthoredDesiredSchema,
  Dialect,
  DialectQueryResolveOptions,
  OperationCommand,
  SelectAst,
  SqlAst,
} from '@/dialects/types'
import type {
  CanonicalRelationIdentityPolicy,
  NamespaceContext,
  NamespaceIdentifierInput,
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
import type { TableHandle } from '@/types'
import { InvariantError } from '@/utils/error'

/** Real db0 selector used only to prove the test member contract; not production support. */
export const EXTENSION_CONTRACT_DIALECT_ID = 'sqlite'
export const EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON =
  'The contract fixture deliberately does not support migration execution'

export type ExtensionContractCalls = {
  events: string[]
  operationCommands: OperationCommand[]
  compiledAst: SqlAst[]
  statements: Array<{ sql: string; params: unknown[] }>
  migrationOutcomes: Array<'applied' | 'unchanged'>
  connector?: Connector
  catalog?: CatalogSnapshot
}

export function createExtensionContractCalls(): ExtensionContractCalls {
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
  comparisonKey: (spelling) => spelling.toLowerCase(),
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
  comparisonKey: (name) => name.toLowerCase(),
  scope: (kind) =>
    kind === 'foreignKey' || kind === 'check'
      ? 'relationConstraints'
      : 'namespaceRelations',
}

function createIdentity(calls: ExtensionContractCalls) {
  return {
    id: EXTENSION_CONTRACT_DIALECT_ID,
    create(options: {
      context: NamespaceContext
      registrationDefault?: readonly NamespaceIdentifierInput[]
    }) {
      calls.events.push('identity.create')
      return createCanonicalRelationIdentityModule({ policy: identityPolicy, ...options })
    },
  }
}

function createNaming(calls: ExtensionContractCalls) {
  return {
    generate(seed: Parameters<typeof generatePhysicalName>[0]) {
      calls.events.push('naming.generate')
      return generatePhysicalName(seed, namingProfile)
    },
    validate(name: string, description: string) {
      calls.events.push('naming.validate')
      return validatePhysicalName(name, description, namingProfile)
    },
    createRegistry() {
      calls.events.push('naming.createRegistry')
      return createPhysicalNameRegistry(namingProfile)
    },
  }
}

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

function assertSimpleContractSelect(node: SelectAst): void {
  if (
    node.joins?.length ||
    node.orderBy?.length ||
    node.groupBy?.length ||
    node.having !== undefined ||
    node.limit !== undefined ||
    node.offset !== undefined
  ) {
    throw new InvariantError(
      'Extension contract compiler only supports simple SELECT clauses',
    )
  }
}

/** Compiles the fixture subset from the same case-folded/defaulted resolution. */
function compileContractQuery(
  node: SqlAst,
  registered: readonly TableHandle[],
  registrationDefault?: readonly NamespaceIdentifierInput[],
): { sql: string; params: unknown[] } {
  if (node.kind !== 'select') {
    throw new InvariantError('Extension contract compiler only supports select queries')
  }

  assertSimpleContractSelect(node)

  const relation = resolveContractQueryRelation(node.relation, registrationDefault)
  const relationMatches = findContractQueryRelationMatches(
    registered,
    node.relation,
    registrationDefault,
  )

  if (relationMatches.length !== 1) {
    throw new InvariantError('Extension contract compiler requires one resolved relation')
  }

  const handle = relationMatches[0]!
  const selection =
    node.selection.length === 1 && node.selection[0]?.kind === 'all'
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
              ? findContractQueryColumnMatches(selectedHandle[0]!, item.column)
              : []

          if (columnMatches.length !== 1) {
            throw new InvariantError(
              'Extension contract compiler requires one resolved selected column',
            )
          }

          return {
            output: item.alias ?? item.column,
            physical: identityPolicy.comparisonKey(columnMatches[0]!),
          }
        })

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
        ? findContractQueryColumnMatches(predicateHandle[0]!, node.where.column)
        : []

    if (columnMatches.length !== 1) {
      throw new InvariantError(
        'Extension contract compiler requires one resolved predicate column',
      )
    }

    parameterColumns.push(identityPolicy.comparisonKey(columnMatches[0]!))
    if (node.where.value !== undefined) params.push(node.where.value)
  }

  const shape: ContractCompiledShape = {
    database: relation.database,
    relation: relation.table,
    columns: selection,
    parameterColumns,
  }
  return { sql: `${CONTRACT_QUERY_PREFIX}${JSON.stringify(shape)}`, params }
}

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

function findContractQueryColumnMatches(
  handle: TableHandle,
  column: string,
): readonly string[] {
  const expected = identityPolicy.comparisonKey(column)
  return Object.keys(handle.getSchema().entries).filter(
    (candidate) => identityPolicy.comparisonKey(candidate) === expected,
  )
}

function lowerSchema(graph: AuthoredDesiredSchema) {
  return {
    tables: graph.tables.map((table) => ({
      handle: table.handle,
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

function createCatalog(
  calls: ExtensionContractCalls,
  identity: ReturnType<typeof createIdentity>,
) {
  const namespaceContext: NamespaceContext = {
    writableDefault: [{ role: 'database', spelling: 'fixture_db' }],
  }

  return {
    async introspectCatalog(
      executor: {
        execute(query: { sql: string; params: unknown[] }): Promise<unknown[]>
      },
      request: CatalogRequest,
    ): Promise<CatalogSnapshot> {
      calls.events.push('catalog.introspect')
      await executor.execute({ sql: 'fixture catalog snapshot', params: [] })
      const unsupported = {
        state: 'unsupported' as const,
        by: 'engine' as const,
        reason: 'The contract fixture deliberately has no identity generation',
      }
      const catalog: CatalogSnapshot = {
        source: { dialect: EXTENSION_CONTRACT_DIALECT_ID, version: 'contract' },
        request: resolvedRequest(request, namespaceContext, identity),
        capabilities: {
          namespaces: { state: 'supported', fidelity: 'portable' },
          relationOwner: unsupported,
          identity: unsupported,
          richObjects: unsupported,
        },
        namespaceContext,
        namespaces: { items: [], coverage: { state: 'complete' } },
        nameReservations: { items: [], coverage: { state: 'complete' } },
        constraintNameReservations: { items: [], coverage: { state: 'complete' } },
        diagnostics: [],
      }
      calls.catalog = catalog
      return catalog
    },
  }
}

function createSessionProvider(
  connector: Connector,
  calls: ExtensionContractCalls,
): OperationSessionProvider {
  calls.connector = connector
  calls.events.push('operations.createSessionProvider')
  let nextSession = 1

  return {
    nativeTransactions: true,
    async open(): Promise<OperationSession> {
      calls.events.push('session.open')
      const physicalSession = `fixture-session-${nextSession++}`
      return {
        identity: { database: 'fixture_db', physicalSession },
        async query(query) {
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
                const source =
                  parameterIndex < 0 ? 'row-1' : String(query.params[parameterIndex])
                return [
                  output,
                  `${shape.database}.${shape.relation}.${physical}:${source}`,
                ]
              }),
            ),
          ]
        },
        async run(query) {
          calls.statements.push(query)
          calls.events.push('session.run')
        },
        async cancel() {
          calls.events.push('session.cancel')
        },
        async release(disposition) {
          calls.events.push(`session.release:${disposition}`)
        },
      }
    },
    async close() {
      calls.events.push('sessionProvider.close')
      await connector.dispose?.()
    },
  }
}

function sameNamespaceInput(
  identity: ReturnType<typeof createIdentity>,
  context: NamespaceContext,
  left: readonly NamespaceIdentifierInput[] | undefined,
  right: readonly NamespaceIdentifierInput[] | undefined,
): boolean {
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

  try {
    return (
      selected.length === expected.length &&
      selected.every(
        (segment, index) =>
          segment.role === expected[index]?.role &&
          segment.identifier.comparisonKey === expected[index]?.identifier.comparisonKey,
      )
    )
  } catch {
    return false
  }
}

function profileIssues(
  identity: ReturnType<typeof createIdentity>,
  planned: MigrationSemanticProfile,
  expected: MigrationSemanticProfile,
) {
  const issues: Array<{
    code: 'profile_mismatch'
    message: string
    sourceStepIndexes: readonly number[]
  }> = []
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

export function createExtensionContractDialect(
  calls: ExtensionContractCalls,
  options?: Readonly<{ migration?: 'supported' | 'unsupported' }>,
): Dialect {
  const identity = createIdentity(calls)
  const naming = createNaming(calls)
  const catalog = createCatalog(calls, identity)
  const schema = {
    lowerDesiredSchema(graph: AuthoredDesiredSchema) {
      calls.events.push('schema.lowerDesiredSchema')
      return lowerSchema(graph)
    },
    inferColumnType() {
      calls.events.push('schema.inferColumnType')
      return 'fixture_text'
    },
    normalizeDataType(dataType: string) {
      return dataType.toLowerCase()
    },
  }
  const query = {
    resolve(registered: readonly TableHandle[], options?: DialectQueryResolveOptions) {
      calls.events.push('query.resolve')
      return {
        compile(node: SqlAst) {
          calls.events.push('query.compile')
          calls.compiledAst.push(node)
          return compileContractQuery(node, registered, options?.registrationDefault)
        },
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
        findColumnMatches(handle: TableHandle, column: string) {
          calls.events.push('query.findColumnMatches')
          return findContractQueryColumnMatches(handle, column)
        },
      }
    },
    mapParamValue(_dataType: string, value: unknown) {
      calls.events.push('query.mapParamValue')
      return `fixture-param:${String(value)}`
    },
    mapResultValue(_dataType: string, value: unknown) {
      calls.events.push('query.mapResultValue')
      return `fixture-result:${String(value)}`
    },
  }

  return {
    id: EXTENSION_CONTRACT_DIALECT_ID,
    identity,
    naming,
    schema,
    query,
    catalog,
    operations: {
      createSessionProvider: (connector) => createSessionProvider(connector, calls),
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
      lower(planned, expectedProfile) {
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

        const actions: MigrationProgram['actions'] = planned.plan.steps.map(
          (step, index) => ({
            sourceStepIndexes: [index],
            transaction: 'allowed',
            statements: [{ sql: `fixture migration ${step.kind} ${index}`, params: [] }],
          }),
        )
        return {
          program: { atomicity: 'statement-atomic', preconditions: [], actions },
        }
      },
      async execute(options) {
        calls.events.push('migration.execute')
        const program = await options.prepare()
        calls.events.push('migration.prepared')

        for (const action of program.actions) {
          for (const statement of action.statements) await options.executor.run(statement)
        }

        const outcome = program.actions.length === 0 ? 'unchanged' : 'applied'
        calls.migrationOutcomes.push(outcome)
        return { outcome }
      },
    },
  }
}
