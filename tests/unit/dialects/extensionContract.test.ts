import type { Connector } from 'db0'
import { pipe, string } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Db } from '@/client'
import { planMigration } from '@/ddl/migrationPlan'
import { registerDialectForTest, resolveDialect } from '@/dialects/resolve'
import type { SqlAst } from '@/dialects/types'
import { column, createDatabase, defineTable } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import {
  EXTENSION_CONTRACT_DIALECT_ID,
  EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON,
  createExtensionContractCalls,
  createExtensionContractDialect,
} from '../helpers/extensionContractDialect'

import { registerDialectContractKit } from './dialectContractKit'
import type { QueryCompilerScenarios } from './dialectContractKit'

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

function createContractRecords(dialectId: string) {
  return defineTable(
    'records',
    {
      id: pipe(string(), column({ physicalType: { [dialectId]: 'fixture_id' } })),
      label: string(),
    },
    { primaryKey: 'id' },
  )
}

function createContractQueryRecords(dialectId: string) {
  return defineTable(
    'records',
    {
      id: pipe(string(), column({ physicalType: { [dialectId]: 'fixture_id' } })),
      label: string(),
      created_at: pipe(
        string(),
        column({ physicalType: { [dialectId]: 'fixture_timestamp' } }),
      ),
    },
    { primaryKey: 'id' },
  )
}

function createContractEvents(dialectId: string) {
  return defineTable(
    'events',
    {
      id: pipe(string(), column({ physicalType: { [dialectId]: 'fixture_id' } })),
      record_id: string(),
      label: string(),
    },
    { primaryKey: 'id' },
  )
}

function createContractRuntime() {
  const calls = createExtensionContractCalls()
  const dialect = createExtensionContractDialect(calls, { migration: 'supported' })
  const { connector, directMethods, disposed } = createContractConnector()
  const Records = createContractRecords(dialect.id)
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
    migration: {
      state: 'supported' as const,
      expected: 'applied' as const,
      observed: calls.migrationOutcomes,
    },
  }
}

const semanticDialect = createExtensionContractDialect(createExtensionContractCalls())
const SemanticRecords = createContractRecords(semanticDialect.id)
const SemanticQueryRecords = createContractQueryRecords(semanticDialect.id)
const SemanticEvents = createContractEvents(semanticDialect.id)
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
const unsupported = (node: SqlAst) => ({
  support: {
    state: 'unsupported' as const,
    reason: 'The synthetic adapter only supports its narrow SELECT projection case',
    input: contractInput(node),
  },
})

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
  'select.join.inner': unsupported({
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
  'select.join.left': unsupported({
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
  'select.join.right': unsupported({
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
  'predicate.comparisons': unsupported({
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
  'predicate.boolean': unsupported({
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
  'predicate.null': unsupported({
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
  'expression.scalar': unsupported({
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
  'expression.aggregate': unsupported({
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
  'clause.group-having-order': unsupported({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'column', column: 'label' }],
    groupBy: [{ column: 'label' }],
    having: { kind: 'cmp', column: 'label', op: 'eq', value: 'yes' },
    orderBy: [{ column: 'label', direction: 'asc' }],
  }),
  'clause.pagination': unsupported({
    kind: 'select',
    relation: contractRelation,
    selection: [{ kind: 'all' }],
    limit: 10,
    offset: 20,
  }),
  'insert.rows-defaults-returning': unsupported({
    kind: 'insert',
    relation: contractRelation,
    columns: ['id', 'label'],
    values: [
      [1, undefined],
      [2, 'second'],
    ],
    returning: { kind: 'columns', columns: ['id', 'label'] },
  }),
  'update.set-where-returning': unsupported({
    kind: 'update',
    relation: contractRelation,
    set: [{ column: 'label', value: 'updated' }],
    where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
    allowAll: false,
    returning: { kind: 'all' },
  }),
  'delete.where-returning': unsupported({
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

registerDialectContractKit({
  name: 'minimal non-PostgreSQL',
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
    input: {
      dialect: semanticDialect,
      executor: { execute: async () => [] },
      request: { relations: [], absentRelations: [], completeNamespaces: [] },
      expected: {
        sourceDialect: EXTENSION_CONTRACT_DIALECT_ID,
        writableDefault: [{ role: 'database', spelling: 'fixture_db' }],
        namespaceCoverage: { state: 'complete' },
        capabilities: {
          namespaces: { state: 'supported', fidelity: 'portable' },
          relationOwner: {
            state: 'unsupported',
            by: 'engine',
            reason: 'The contract fixture deliberately has no identity generation',
          },
          identity: {
            state: 'unsupported',
            by: 'engine',
            reason: 'The contract fixture deliberately has no identity generation',
          },
          richObjects: {
            state: 'unsupported',
            by: 'engine',
            reason: 'The contract fixture deliberately has no identity generation',
          },
        },
      },
    },
  },
  operationSession: {
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
                ...profile,
                identityAdapter: 'contract-other-identity',
              },
              namespaceContext: {
                ...profile,
                namespaceContext: {
                  writableDefault: [{ role: 'database', spelling: 'other_database' }],
                },
              },
              registrationDefault: {
                ...profile,
                registrationDefault: [
                  { role: 'database', spelling: 'other_registration' },
                ],
              },
            },
            expectedProgram: {
              atomicity: 'statement-atomic',
              actionCount: 2,
              sourceStepIndexes: [[0], [1]],
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
})

describe('dialect extension contract', () => {
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
