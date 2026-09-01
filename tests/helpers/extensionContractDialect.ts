import type { Connector } from 'db0'

import type { MigrationSemanticProfile } from '@/ddl/migrationPlan'
import type { MigrationProgram } from '@/ddl/migrationProgram'
import type { CatalogRequest, CatalogSnapshot } from '@/dialects/catalog'
import type {
  AuthoredDesiredSchema,
  Dialect,
  OperationCommand,
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

function valueParameters(node: SqlAst): unknown[] {
  if (node.kind !== 'select' || node.where?.kind !== 'cmp') return []
  return node.where.value === undefined ? [] : [node.where.value]
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
          return query.sql === 'fixture query'
            ? [{ id: 'row-1', label: 'stored-value' }]
            : []
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
    compile(node: SqlAst) {
      calls.events.push('query.compile')
      calls.compiledAst.push(node)
      return { sql: 'fixture query', params: valueParameters(node) }
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
