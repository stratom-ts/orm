import type { Connector } from 'db0'
import { pipe, string } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Db } from '@/client'
import { planMigration } from '@/ddl/migrationPlan'
import type { MigrationPlan } from '@/ddl/migrationPlan'
import { registerDialectForTest, resolveDialect } from '@/dialects/resolve'
import type { Dialect, SqlAst } from '@/dialects/types'
import { column, createDatabase, defineTable } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import {
  EXTENSION_CONTRACT_DIALECT_ID,
  EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON,
  createExtensionContractCalls,
  createExtensionContractDialect,
} from '../helpers/extensionContractDialect'

import { registerDialectContractMember, runCatalogContract } from './dialectContractKit'
import type {
  CatalogContractInput,
  DialectContractMemberCapabilities,
  QueryCompilerScenarios,
} from './dialectContractKit'
import {
  registerDialectLifecycleContract,
  runDialectLifecycleContract,
} from './dialectMemberContract'

let unregister: (() => void) | undefined

afterEach(() => {
  unregister?.()
  unregister = undefined
})

function createContractConnector() {
  let disposed = false
  const getInstance = vi.fn(() => {
    throw new Error('The selected member must not use connector.getInstance directly')
  })
  const exec = vi.fn(() => {
    throw new Error('The selected member must not use connector.exec directly')
  })
  const prepare = vi.fn(() => {
    throw new Error('The selected member must not use connector.prepare directly')
  })
  const connector = {
    name: EXTENSION_CONTRACT_DIALECT_ID,
    dialect: EXTENSION_CONTRACT_DIALECT_ID,
    getInstance,
    exec,
    prepare,
    async dispose() {
      disposed = true
    },
  } satisfies Connector
  return {
    connector,
    directMethods: { getInstance, exec, prepare },
    disposed: () => disposed,
  }
}

function createContractRecords() {
  return defineTable(
    'records',
    {
      id: pipe(
        string(),
        column({ physicalType: { [EXTENSION_CONTRACT_DIALECT_ID]: 'fixture_id' } }),
      ),
      label: string(),
    },
    { primaryKey: 'id' },
  )
}

function createContractQueryRecords() {
  return defineTable(
    'records',
    {
      id: pipe(
        string(),
        column({ physicalType: { [EXTENSION_CONTRACT_DIALECT_ID]: 'fixture_id' } }),
      ),
      label: string(),
      created_at: pipe(
        string(),
        column({
          physicalType: { [EXTENSION_CONTRACT_DIALECT_ID]: 'fixture_timestamp' },
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

function createContractEvents() {
  return defineTable(
    'events',
    {
      id: pipe(
        string(),
        column({ physicalType: { [EXTENSION_CONTRACT_DIALECT_ID]: 'fixture_id' } }),
      ),
      record_id: string(),
      label: string(),
    },
    { primaryKey: 'id' },
  )
}

const expectedExtensionMigrationPlan = {
  steps: [
    {
      kind: 'ensure_namespace',
      target: {
        kind: 'namespace',
        namespace: [
          {
            role: 'database',
            identifier: {
              spelling: 'fixture_tenant',
              comparisonKey: 'fixture_tenant',
            },
          },
        ],
      },
    },
    {
      kind: 'create_table',
      target: {
        kind: 'relation',
        relation: {
          namespace: [
            {
              role: 'database',
              identifier: {
                spelling: 'fixture_tenant',
                comparisonKey: 'fixture_tenant',
              },
            },
          ],
          relation: { spelling: 'records', comparisonKey: 'records' },
        },
      },
    },
  ],
} satisfies MigrationPlan

function createContractRuntime(
  options?: Readonly<{
    migration?: 'supported' | 'unsupported'
    emptyPlanReportsApplied?: Readonly<{
      executionReported: { value: boolean }
      postMigrationStateObserved: { value: boolean }
    }>
  }>,
): import('./dialectMemberContract').DialectLifecycleContractRuntime {
  const calls = createExtensionContractCalls()
  const unsupportedMigration = options?.migration === 'unsupported'
  const baseDialect = createExtensionContractDialect(
    calls,
    unsupportedMigration ? { migration: 'unsupported' } : undefined,
  )
  const faultyLifecycle = options?.emptyPlanReportsApplied
  const dialect: Dialect = faultyLifecycle
    ? {
        ...baseDialect,
        migration: {
          ...baseDialect.migration,
          lower() {
            return {
              program: {
                atomicity: 'statement-atomic' as const,
                preconditions: [],
                actions: [],
              },
            }
          },
          async execute(
            migrationOptions: Parameters<typeof baseDialect.migration.execute>[0],
          ) {
            await migrationOptions.prepare()
            calls.migrationOutcomes.push('applied')
            faultyLifecycle.executionReported.value = true
            return { outcome: 'applied' as const }
          },
        },
      }
    : baseDialect
  const { connector, directMethods, disposed } = createContractConnector()
  const Records = createContractRecords()
  return {
    dialect,
    connector,
    schemas: [Records],
    defaultNamespace: [{ role: 'database' as const, spelling: 'fixture_tenant' }],
    executeQuery: (database: Db) =>
      database.from(Records).where(Records.label, 'eq', 'authored-value').execute(),
    operationCommands: calls.operationCommands,
    catalog: () => calls.catalog,
    selectedConnector: () => calls.connector,
    disposed,
    queryParams: () =>
      calls.statements.find(({ sql }) => sql.startsWith('fixture query:'))?.params,
    foreignPolicyLeak: () =>
      calls.statements.some(({ sql }) => /postgres|pg_|public/i.test(sql)),
    directConnectorMethods: Object.values(directMethods),
    expected: {
      queryRows: [
        {
          id: 'fixture-result:fixture_tenant.records.id:row-1',
          label:
            'fixture-result:fixture_tenant.records.label:fixture-param:authored-value',
        },
      ],
      queryParam: 'fixture-param:authored-value',
    },
    postMigrationState: () => {
      if (faultyLifecycle) faultyLifecycle.postMigrationStateObserved.value = true

      return calls.statements
        .filter(({ sql }) => sql.startsWith('fixture migration '))
        .map(({ sql }) => sql)
    },
    migration: unsupportedMigration
      ? {
          state: 'unsupported' as const,
          reason: EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON,
          expectedPlan: expectedExtensionMigrationPlan,
          expectedPostMigrationState: [],
        }
      : {
          state: 'supported' as const,
          expectedPlan: expectedExtensionMigrationPlan,
          expectedPostMigrationState: [
            'fixture migration ensure_namespace 0',
            'fixture migration create_table 1',
          ],
          reportedOutcome: {
            expected: 'applied' as const,
            observed: calls.migrationOutcomes,
          },
        },
  }
}

const semanticDialect = createExtensionContractDialect(createExtensionContractCalls())
const SemanticRecords = createContractRecords()
const SemanticQueryRecords = createContractQueryRecords()
const SemanticEvents = createContractEvents()
const semanticContext = {
  writableDefault: [{ role: 'database' as const, spelling: 'fixture_tenant' }],
}
const semanticQuery: SqlAst = {
  kind: 'select',
  relation: { relation: 'records' },
  selection: [{ kind: 'column', column: 'label' }],
  where: { kind: 'cmp', column: 'label', op: 'eq', value: 'authored-value' },
}

const contractRelation = { relation: 'records' } as const
const contractJoinedRelation = { relation: 'events' } as const
const contractInput = (node: SqlAst) => ({
  dialect: semanticDialect,
  handles: [SemanticQueryRecords, SemanticEvents],
  registrationDefault: semanticContext.writableDefault,
  node,
})
const unsupported = (expectedMessage: string) => (node: SqlAst) => ({
  support: {
    state: 'unsupported' as const,
    reason: 'The synthetic adapter only supports its narrow SELECT projection case',
    input: contractInput(node),
    expectedMessage,
  },
})
const unsupportedSimpleSelect = unsupported(
  'Extension contract compiler only supports simple SELECT clauses',
)
const unsupportedPredicate = unsupported(
  'Extension contract compiler only supports one value predicate',
)
const unsupportedSelection = unsupported(
  'Extension contract compiler only supports column selections',
)
const unsupportedNonSelect = unsupported(
  'Extension contract compiler only supports select queries',
)

const extensionCompilerScenarios = {
  'select.projection': {
    support: {
      state: 'supported',
      input: {
        ...contractInput(semanticQuery),
        expected: {
          sql: 'fixture query:{"database":"fixture_tenant","relation":"records","columns":[{"output":"label","physical":"label"}],"parameterColumns":["label"]}',
          params: ['authored-value'],
        },
      },
    },
  },
  'select.namespace': {
    support: {
      state: 'supported',
      input: {
        ...contractInput({
          kind: 'select',
          relation: {
            namespace: [{ role: 'database', spelling: 'fixture_tenant' }],
            relation: 'records',
          },
          selection: [{ kind: 'all' }],
        }),
        expected: {
          sql: 'fixture query:{"database":"fixture_tenant","relation":"records","columns":[{"output":"id","physical":"id"},{"output":"label","physical":"label"},{"output":"created_at","physical":"created_at"}],"parameterColumns":[]}',
          params: [],
        },
      },
    },
  },
  'select.join.inner': unsupportedSimpleSelect({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'all' }],
    joins: [
      {
        type: 'inner',
        relation: contractJoinedRelation,
        on: {
          kind: 'cmp',
          relation: contractRelation,
          column: 'id',
          op: 'eq',
          right: { relation: contractJoinedRelation, column: 'record_id' },
        },
      },
    ],
  }),
  'select.join.left': unsupportedSimpleSelect({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'all' }],
    joins: [
      {
        type: 'left',
        relation: contractJoinedRelation,
        on: {
          kind: 'cmp',
          relation: contractRelation,
          column: 'id',
          op: 'eq',
          right: { relation: contractJoinedRelation, column: 'record_id' },
        },
      },
    ],
  }),
  'select.join.right': unsupportedSimpleSelect({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'all' }],
    joins: [
      {
        type: 'right',
        relation: contractJoinedRelation,
        on: {
          kind: 'cmp',
          relation: contractRelation,
          column: 'id',
          op: 'eq',
          right: { relation: contractJoinedRelation, column: 'record_id' },
        },
      },
    ],
  }),
  'predicate.comparisons': unsupportedPredicate({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'all' }],
    where: {
      kind: 'and',
      preds: [
        { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
        { kind: 'cmp', column: 'id', op: 'neq', value: 2 },
        { kind: 'cmp', column: 'id', op: 'gt', value: 3 },
        { kind: 'cmp', column: 'id', op: 'gte', value: 4 },
        { kind: 'cmp', column: 'id', op: 'lt', value: 5 },
        { kind: 'cmp', column: 'id', op: 'lte', value: 6 },
      ],
    },
  }),
  'predicate.boolean': unsupportedPredicate({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'all' }],
    where: {
      kind: 'not',
      pred: {
        kind: 'or',
        preds: [
          { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
          {
            kind: 'and',
            preds: [
              { kind: 'cmp', column: 'id', op: 'gt', value: 2 },
              { kind: 'cmp', column: 'id', op: 'lt', value: 9 },
            ],
          },
        ],
      },
    },
  }),
  'predicate.null': unsupportedPredicate({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'all' }],
    where: {
      kind: 'or',
      preds: [
        { kind: 'cmp', column: 'label', op: 'eq', value: null },
        { kind: 'cmp', column: 'label', op: 'neq', value: null },
      ],
    },
  }),
  'expression.scalar': unsupportedSelection({
    kind: 'select',
    relation: contractRelation,
    selection: [
      {
        kind: 'expr',
        expr: { kind: 'lower', arg: { kind: 'column', column: 'label' } },
        alias: 'lowered',
      },
      {
        kind: 'expr',
        expr: { kind: 'upper', arg: { kind: 'column', column: 'label' } },
        alias: 'uppered',
      },
      {
        kind: 'expr',
        expr: { kind: 'length', arg: { kind: 'column', column: 'label' } },
        alias: 'size',
      },
      { kind: 'expr', expr: { kind: 'now' }, alias: 'queriedAt' },
      {
        kind: 'expr',
        expr: {
          kind: 'date_trunc',
          unit: 'day',
          arg: { kind: 'column', column: 'created_at' },
        },
        alias: 'day',
      },
    ],
  }),
  'expression.aggregate': unsupportedSelection({
    kind: 'select',
    relation: contractRelation,
    selection: [
      { kind: 'expr', expr: { kind: 'count_all' }, alias: 'total' },
      {
        kind: 'expr',
        expr: { kind: 'count', arg: { kind: 'column', column: 'id' } },
        alias: 'ids',
      },
      {
        kind: 'expr',
        expr: { kind: 'min', arg: { kind: 'column', column: 'id' } },
        alias: 'smallest',
      },
      {
        kind: 'expr',
        expr: { kind: 'max', arg: { kind: 'column', column: 'id' } },
        alias: 'largest',
      },
      {
        kind: 'expr',
        expr: { kind: 'sum', arg: { kind: 'column', column: 'id' } },
        alias: 'sum',
      },
    ],
  }),
  'clause.group-having-order': unsupportedSimpleSelect({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'column', column: 'label' }],
    groupBy: [{ column: 'label' }],
    having: { kind: 'cmp', column: 'label', op: 'eq', value: 'yes' },
    orderBy: [{ column: 'label', direction: 'asc' }],
  }),
  'clause.pagination': unsupportedSimpleSelect({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'all' }],
    limit: 10,
    offset: 20,
  }),
  'insert.rows-defaults-returning': unsupportedNonSelect({
    kind: 'insert',
    relation: contractRelation,
    columns: ['id', 'label'],
    values: [
      [1, undefined],
      [2, 'second'],
    ],
    returning: { kind: 'columns', columns: ['id', 'label'] },
  }),
  'update.set-where-returning': unsupportedNonSelect({
    kind: 'update',
    relation: contractRelation,
    set: [{ column: 'label', value: 'updated' }],
    where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
    allowAll: false,
    returning: { kind: 'all' },
  }),
  'delete.where-returning': unsupportedNonSelect({
    kind: 'delete',
    relation: contractRelation,
    where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
    allowAll: false,
    returning: { kind: 'columns', columns: ['id'] },
  }),
} satisfies QueryCompilerScenarios

async function createSemanticPlannedMigration() {
  const request = createCatalogRequest([SemanticRecords], [])
  const catalog = await semanticDialect.catalog.introspectCatalog(
    { execute: async () => [] },
    request,
  )
  const planned = planMigration(
    [SemanticRecords],
    catalog,
    semanticDialect.migration.planning,
  )
  return { planned, profile: planned.profile }
}

const extensionContractCapabilities = {
  identity: { state: 'supported', shard: 'complete' },
  naming: { state: 'supported', shard: 'complete' },
  desiredSchema: { state: 'supported', shard: 'complete' },
  query: { state: 'supported', shard: 'complete' },
  catalog: { state: 'supported', shard: 'complete' },
  operationSession: { state: 'supported', shard: 'complete' },
  coordination: {
    state: 'unsupported',
    reason: 'The synthetic adapter has no cross-client migration lock primitive',
    shard: 'complete',
  },
  migration: { state: 'supported', shard: 'complete' },
  lifecycle: { state: 'supported', shard: 'complete' },
} as const satisfies DialectContractMemberCapabilities

const extensionCatalogContractInput = {
  dialect: semanticDialect,
  executor: {
    execute: async () => [
      {
        kind: 'namespace' as const,
        namespace: [{ role: 'database' as const, spelling: 'empty_database' }],
      },
      {
        kind: 'namespace' as const,
        namespace: [{ role: 'database' as const, spelling: 'fixture_db' }],
      },
      {
        kind: 'relation' as const,
        namespace: [{ role: 'database' as const, spelling: 'fixture_db' }],
        relation: 'present_records',
      },
      {
        kind: 'relation' as const,
        namespace: [{ role: 'database' as const, spelling: 'fixture_db' }],
        relation: 'absent_records',
      },
    ],
  },
  request: {
    relations: [
      {
        relation: { relation: 'present_records' },
        shape: 'complete' as const,
      },
    ],
    absentRelations: [{ relation: 'absent_records' }],
    completeNamespaces: [[{ role: 'database' as const, spelling: 'empty_database' }]],
  },
  expected: {
    sourceDialect: EXTENSION_CONTRACT_DIALECT_ID,
    writableDefault: [{ role: 'database' as const, spelling: 'fixture_db' }],
    namespaceCoverage: { state: 'complete' as const },
    capabilities: {
      namespaces: { state: 'supported' as const, fidelity: 'portable' as const },
      relationOwner: {
        state: 'unsupported' as const,
        by: 'engine' as const,
        reason: 'The contract fixture deliberately has no identity generation',
      },
      identity: {
        state: 'unsupported' as const,
        by: 'engine' as const,
        reason: 'The contract fixture deliberately has no identity generation',
      },
      richObjects: {
        state: 'unsupported' as const,
        by: 'engine' as const,
        reason: 'The contract fixture deliberately has no identity generation',
      },
    },
    request: {
      relations: [
        {
          identity: {
            namespace: [{ role: 'database' as const, spelling: 'fixture_db' }],
            relation: 'present_records',
          },
          shape: 'complete' as const,
        },
      ],
      absentRelations: [
        {
          namespace: [{ role: 'database' as const, spelling: 'fixture_db' }],
          relation: 'absent_records',
        },
      ],
      completeNamespaces: [[{ role: 'database' as const, spelling: 'empty_database' }]],
    },
    namespaces: [
      {
        identity: [{ role: 'database' as const, spelling: 'empty_database' }],
        relationCoverage: { state: 'complete' as const },
        relations: [],
      },
      {
        identity: [{ role: 'database' as const, spelling: 'fixture_db' }],
        relationCoverage: {
          state: 'partial' as const,
          remainder: {
            state: 'unmanaged' as const,
            reason: 'Relations outside the requested catalog scope are unmanaged',
          },
        },
        relations: [
          {
            namespace: [{ role: 'database' as const, spelling: 'fixture_db' }],
            relation: 'present_records',
          },
          {
            namespace: [{ role: 'database' as const, spelling: 'fixture_db' }],
            relation: 'absent_records',
          },
        ],
      },
    ],
  },
} satisfies CatalogContractInput

it('rejects relation evidence whose requested namespace was not observed', async () => {
  await expect(
    semanticDialect.catalog.introspectCatalog(
      {
        execute: async () => [
          {
            kind: 'relation',
            namespace: [{ role: 'database', spelling: 'missing_database' }],
            relation: 'orphan_records',
          },
        ],
      },
      {
        relations: [
          {
            relation: {
              namespace: [{ role: 'database', spelling: 'missing_database' }],
              relation: 'orphan_records',
            },
            shape: 'complete',
          },
        ],
        absentRelations: [],
        completeNamespaces: [
          [{ role: 'database' as const, spelling: 'missing_database' }],
        ],
      },
    ),
  ).rejects.toThrow(/relation row requires an observed namespace row/i)
})

it.each([
  {
    description: 'an unknown row kind',
    row: { kind: 'unknown' },
    message: /fixture row 0.*kind 'namespace' or 'relation'/i,
  },
  {
    description: 'a malformed namespace segment',
    row: { kind: 'namespace', namespace: [{ role: 'database' }] },
    message: /fixture row 0.*valid namespace role\/spelling segments/i,
  },
  {
    description: 'an empty relation spelling',
    row: {
      kind: 'relation',
      namespace: [{ role: 'database', spelling: 'fixture_db' }],
      relation: '',
    },
    message: /fixture row 0.*non-empty relation spelling/i,
  },
])('rejects $description in catalog fixture rows', async ({ row, message }) => {
  await expect(
    semanticDialect.catalog.introspectCatalog(
      { execute: async () => [row] },
      { relations: [], absentRelations: [], completeNamespaces: [] },
    ),
  ).rejects.toThrow(message)
})

it.each(['relations', 'absentRelations', 'completeNamespaces'] as const)(
  'shared catalog contract rejects an adapter that ignores the requested %s scope',
  async (field) => {
    const faultyDialect: Dialect = {
      ...semanticDialect,
      catalog: {
        async introspectCatalog(executor, request) {
          const ignoredRequest = { ...request, [field]: [] }
          const snapshot = await semanticDialect.catalog.introspectCatalog(
            executor,
            ignoredRequest,
          )
          const reportedRequest = await semanticDialect.catalog.introspectCatalog(
            { execute: async () => [] },
            request,
          )
          return {
            ...snapshot,
            request: reportedRequest.request,
          }
        },
      },
    }

    await expect(
      runCatalogContract({
        ...extensionCatalogContractInput,
        dialect: faultyDialect,
      }),
    ).rejects.toThrow()
  },
)

registerDialectContractMember('minimal non-PostgreSQL', extensionContractCapabilities, {
  complete: {
    identity: {
      state: 'supported',
      input: {
        dialect: semanticDialect,
        context: semanticContext,
        relation: { relation: 'Records' },
        expected: {
          namespace: [
            {
              role: 'database',
              identifier: { spelling: 'fixture_tenant', comparisonKey: 'fixture_tenant' },
            },
          ],
          relation: { spelling: 'Records', comparisonKey: 'records' },
        },
      },
    },
    naming: {
      state: 'supported',
      input: {
        dialect: semanticDialect,
        context: semanticContext,
        owner: { relation: 'records' },
        columns: ['label'],
        expectedName: 'records_label__75ac86d626c6ad68_idx',
        collisionName: 'contract_collision_idx',
      },
    },
    desiredSchema: {
      state: 'supported',
      input: {
        dialect: semanticDialect,
        context: semanticContext,
        handles: [SemanticRecords],
        expected: [
          {
            namespace: [{ role: 'database', spelling: 'fixture_tenant' }],
            relation: 'records',
            columns: [
              { name: 'id', dataType: 'fixture_id' },
              { name: 'label', dataType: 'fixture_text' },
            ],
            primaryKey: ['id'],
          },
        ],
      },
    },
    query: {
      state: 'supported',
      core: {
        state: 'supported',
        input: {
          dialect: semanticDialect,
          handles: [SemanticRecords],
          target: SemanticRecords,
          registrationDefault: semanticContext.writableDefault,
          relation: { relation: 'records' },
          column: 'label',
          node: semanticQuery,
          inspectCompiled: (query) => ({
            parameterCount: query.params.length,
            foreignPolicyLeak: /postgres|pg_|public/i.test(query.sql),
          }),
          expected: {
            relationMatches: ['records'],
            columnMatches: ['label'],
            compiled: { parameterCount: 1, foreignPolicyLeak: false },
          },
        },
      },
      scenarios: extensionCompilerScenarios,
      valueMapping: {
        state: 'supported',
        input: {
          dialect: semanticDialect,
          dataType: 'fixture_text',
          paramValue: 'authored-value',
          resultValue: 'stored-value',
          expected: {
            mappedParam: 'fixture-param:authored-value',
            mappedResult: 'fixture-result:stored-value',
          },
        },
      },
    },
    catalog: {
      state: 'supported',
      input: extensionCatalogContractInput,
    },
    operationSession: {
      state: 'supported',
      common: {
        state: 'supported',
        input: {
          createRuntime() {
            const calls = createExtensionContractCalls()
            const dialect = createExtensionContractDialect(calls)
            return {
              provider: dialect.operations.createSessionProvider(
                createContractConnector().connector,
              ),
              events: () =>
                calls.events.flatMap((event) => {
                  if (event === 'session.query') return ['query' as const]
                  if (event === 'session.run') return ['run' as const]
                  if (event === 'session.cancel') return ['cancel' as const]

                  if (event === 'session.release:reuse') {
                    return ['release:reuse' as const]
                  }

                  if (event === 'sessionProvider.close') return ['close' as const]

                  return []
                }),
            }
          },
        },
      },
      controlled: {
        state: 'unsupported',
        reason: 'The synthetic adapter does not emulate provider failure controls',
      },
    },
    coordination: {
      state: 'unsupported',
      reason: 'The synthetic adapter has no cross-client migration lock primitive',
    },
    migration: {
      state: 'supported',
      input: {
        lowering: {
          async createCase() {
            const { planned, profile } = await createSemanticPlannedMigration()
            return {
              dialect: semanticDialect,
              planned,
              profile,
              mismatchedProfiles: {
                identityAdapter: {
                  profile: {
                    ...profile,
                    identityAdapter: 'contract-other-identity',
                  },
                  issues: [
                    {
                      code: 'profile_mismatch',
                      message:
                        'Contract fixture identity adapter does not match the executing profile',
                      sourceStepIndexes: [],
                    },
                    {
                      code: 'profile_mismatch',
                      message:
                        'Executing identity adapter does not select the contract fixture',
                      sourceStepIndexes: [],
                    },
                  ],
                },
                namespaceContext: {
                  profile: {
                    ...profile,
                    namespaceContext: {
                      writableDefault: [{ role: 'database', spelling: 'other_database' }],
                    },
                  },
                  issues: [
                    {
                      code: 'profile_mismatch',
                      message:
                        'Contract fixture writable namespace context does not match',
                      sourceStepIndexes: [],
                    },
                  ],
                },
                registrationDefault: {
                  profile: {
                    ...profile,
                    registrationDefault: [
                      { role: 'database', spelling: 'other_registration' },
                    ],
                  },
                  issues: [
                    {
                      code: 'profile_mismatch',
                      message: 'Contract fixture registration default does not match',
                      sourceStepIndexes: [],
                    },
                  ],
                },
              },
              expectedProgram: {
                atomicity: 'statement-atomic',
                preconditions: [],
                actions: [
                  {
                    sourceStepIndexes: [0],
                    transaction: 'allowed',
                    statements: [
                      { sql: 'fixture migration ensure_namespace 0', params: [] },
                    ],
                  },
                  {
                    sourceStepIndexes: [1],
                    transaction: 'allowed',
                    statements: [{ sql: 'fixture migration create_table 1', params: [] }],
                  },
                ],
              },
            }
          },
        },
        unsupportedLowering: {
          state: 'supported',
          input: {
            async createCase() {
              const { planned, profile } = await createSemanticPlannedMigration()
              return {
                dialect: createExtensionContractDialect(createExtensionContractCalls(), {
                  migration: 'unsupported',
                }),
                planned,
                profile,
                issue: {
                  code: 'compile_failure',
                  message: EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON,
                  sourceStepIndexes: [0, 1],
                },
              }
            },
          },
        },
      },
    },
    lifecycle: {
      state: 'supported',
      input: createContractRuntime,
    },
  },
})

registerDialectLifecycleContract('Extension unsupported migration', () =>
  createContractRuntime({ migration: 'unsupported' }),
)

describe('dialect extension contract', () => {
  it('rejects an empty program that falsely reports an applied migration', async () => {
    const faultyLifecycle = {
      executionReported: { value: false },
      postMigrationStateObserved: { value: false },
    }

    await expect(
      runDialectLifecycleContract(
        createContractRuntime({ emptyPlanReportsApplied: faultyLifecycle }),
      ),
    ).rejects.toThrow(/deeply equal/i)

    expect(faultyLifecycle.executionReported.value).toBe(true)
    expect(faultyLifecycle.postMigrationStateObserved.value).toBe(true)
  })

  it('rejects an unsupported lifecycle that returns the wrong Migration Plan', async () => {
    const runtime = createContractRuntime({ migration: 'unsupported' })
    const faultyRuntime = {
      ...runtime,
      schemas: [...runtime.schemas, createContractEvents()],
    }

    await expect(runDialectLifecycleContract(faultyRuntime)).rejects.toThrow(
      /deeply equal/i,
    )
  })

  it('rejects an unsupported lifecycle that mutates observable state', async () => {
    const runtime = createContractRuntime({ migration: 'unsupported' })
    const postMigrationStateObserved = { value: false }
    const faultyRuntime = {
      ...runtime,
      postMigrationState: () => {
        postMigrationStateObserved.value = true
        return ['unexpected migration statement']
      },
    }

    await expect(runDialectLifecycleContract(faultyRuntime)).rejects.toThrow(
      /deeply equal/i,
    )

    expect(postMigrationStateObserved.value).toBe(true)
  })

  it('rejects a compiler that disagrees with the reusable Query agreement case', async () => {
    const runtime = createContractRuntime()
    const matching = runtime.dialect.query
    const mismatched = {
      ...runtime,
      dialect: {
        ...runtime.dialect,
        query: {
          ...matching,
          resolve(handles: Parameters<typeof matching.resolve>[0]) {
            return {
              ...matching.resolve(handles),
              compile: () => ({ sql: 'mismatched query', params: [] }),
            }
          },
        },
      },
    }
    const Records = defineTable(
      'records',
      {
        id: pipe(
          string(),
          column({ physicalType: { [runtime.dialect.id]: 'fixture_id' } }),
        ),
        label: string(),
      },
      { primaryKey: 'id' },
    )
    unregister = registerDialectForTest(mismatched.dialect)
    const db = createDatabase({ connector: mismatched.connector, schemas: [Records] })

    try {
      const rows = await db
        .from(Records)
        .where(Records.label, 'eq', 'authored-value')
        .execute()
      expect(() => {
        expect(rows).toEqual(mismatched.expected.queryRows)
        expect(mismatched.queryParams()).toEqual([mismatched.expected.queryParam])
      }).toThrow()
    } finally {
      await db.close()
    }
  })

  it('keeps contract registration isolated and rejects duplicate members', () => {
    const member = createExtensionContractDialect(createExtensionContractCalls())
    unregister = registerDialectForTest(member)

    expect(resolveDialect(EXTENSION_CONTRACT_DIALECT_ID)).toBe(member)
    expect(() => registerDialectForTest(member)).toThrow(/already registered/)

    unregister()
    unregister = undefined

    expect(() => resolveDialect(EXTENSION_CONTRACT_DIALECT_ID)).toThrow(
      /unsupported connector dialect/,
    )
  })

  it('rejects invalid test registration ids without mutating the dispatcher', () => {
    const member = createExtensionContractDialect(createExtensionContractCalls())

    expect(() => registerDialectForTest({ ...member, id: ' ' })).toThrow(
      /non-empty identifier/,
    )

    expect(() => resolveDialect(EXTENSION_CONTRACT_DIALECT_ID)).toThrow(
      /unsupported connector dialect/,
    )
  })
})
