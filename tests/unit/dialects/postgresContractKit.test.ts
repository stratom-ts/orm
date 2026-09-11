import { string } from 'valibot'

import { planMigration } from '@/ddl/migrationPlan'
import type { CatalogExecutor, CatalogRequest } from '@/dialects'
import type { SqlAst } from '@/dialects/types'
import { defineTable, postgresDialect } from '@/index'

import { registerDialectContractKit } from './dialectContractKit'

const namespaceContext = {
  writableDefault: [
    { role: 'database' as const, spelling: 'contract_database' },
    { role: 'schema' as const, spelling: 'contract_schema' },
  ],
}
const Records = defineTable(
  'records',
  { id: string(), label: string() },
  { primaryKey: 'id' },
)
const queryNode: SqlAst = {
  kind: 'select',
  relation: { relation: 'records' },
  selection: [{ kind: 'column', column: 'label' }],
  where: { kind: 'cmp', column: 'label', op: 'eq', value: 'authored-value' },
}

const emptyCatalogRequest: CatalogRequest = {
  relations: [],
  absentRelations: [],
  completeNamespaces: [],
}

const emptyCatalogExecutor: CatalogExecutor = {
  async execute({ sql }) {
    if (sql.includes('current_database()')) {
      return [
        {
          database: 'contract_database',
          schema: 'contract_schema',
          version: '160000',
        },
      ]
    }

    return []
  },
}

registerDialectContractKit({
  name: 'PostgreSQL',
  identity: {
    state: 'supported',
    input: {
      dialect: postgresDialect,
      context: namespaceContext,
      relation: { relation: 'records' },
      expected: {
        namespace: [
          {
            role: 'database',
            identifier: {
              spelling: 'contract_database',
              comparisonKey: 'contract_database',
            },
          },
          {
            role: 'schema',
            identifier: {
              spelling: 'contract_schema',
              comparisonKey: 'contract_schema',
            },
          },
        ],
        relation: { spelling: 'records', comparisonKey: 'records' },
      },
    },
  },
  naming: {
    state: 'supported',
    input: {
      dialect: postgresDialect,
      context: namespaceContext,
      owner: { relation: 'records' },
      columns: ['label'],
      expectedName: 'records_label__8049ce336585d5ab_idx',
      collisionName: 'contract_collision_idx',
    },
  },
  desiredSchema: {
    state: 'supported',
    input: {
      dialect: postgresDialect,
      context: namespaceContext,
      handles: [Records],
      expected: [
        {
          namespace: [
            { role: 'database', spelling: 'contract_database' },
            { role: 'schema', spelling: 'contract_schema' },
          ],
          relation: 'records',
          columns: [
            { name: 'id', dataType: 'text' },
            { name: 'label', dataType: 'text' },
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
        dialect: postgresDialect,
        handles: [Records],
        target: Records,
        registrationDefault: namespaceContext.writableDefault,
        relation: { relation: 'records' },
        column: 'label',
        node: queryNode,
        inspectCompiled: (query) => ({
          parameterCount: query.params.length,
          addressesRelation: query.sql.includes('"contract_schema"."records"'),
          addressesColumn: query.sql.includes('"label"'),
        }),
        expected: {
          relationMatches: ['records'],
          columnMatches: ['label'],
          compiled: {
            parameterCount: 1,
            addressesRelation: true,
            addressesColumn: true,
          },
        },
      },
    },
    valueMapping: {
      state: 'supported',
      input: {
        dialect: postgresDialect,
        dataType: 'jsonb',
        paramValue: { key: 'value' },
        resultValue: '{"key":"value"}',
        expected: {
          mappedParam: '{"key":"value"}',
          mappedResult: { key: 'value' },
        },
      },
    },
  },
  catalog: {
    state: 'supported',
    input: {
      dialect: postgresDialect,
      executor: emptyCatalogExecutor,
      request: emptyCatalogRequest,
      expected: {
        sourceDialect: 'postgresql',
        writableDefault: namespaceContext.writableDefault,
        namespaceCoverage: { state: 'complete' },
        capabilities: {
          namespaces: { state: 'supported', fidelity: 'native' },
          relationOwner: { state: 'supported', fidelity: 'native' },
          identity: { state: 'supported', fidelity: 'native' },
          richObjects: { state: 'supported', fidelity: 'opaque' },
        },
      },
    },
  },
  migration: {
    state: 'supported',
    input: {
      lowering: {
        async createCase() {
          const catalog = await postgresDialect.catalog.introspectCatalog(
            emptyCatalogExecutor,
            emptyCatalogRequest,
          )
          const planned = planMigration([], catalog, postgresDialect.migration.planning)
          const profile = planned.profile
          return {
            dialect: postgresDialect,
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
                  writableDefault: [
                    { role: 'database', spelling: 'other_database' },
                    { role: 'schema', spelling: 'other_schema' },
                  ],
                },
              },
              registrationDefault: {
                ...profile,
                registrationDefault: [{ role: 'schema', spelling: 'other_schema' }],
              },
            },
            expectedProgram: {
              atomicity: 'plan-atomic',
              actionCount: 0,
              sourceStepIndexes: [],
            },
          }
        },
      },
      unsupportedLowering: {
        state: 'unsupported',
        reason: 'The shared empty PostgreSQL plan has no unsupported lowering case',
      },
    },
  },
})
