import { date, number, pipe, string } from 'valibot'

import { planMigration } from '@/ddl/migrationPlan'
import type { MigrationPlan } from '@/ddl/migrationPlan'
import type { CatalogExecutor, CatalogRequest, OperationCommand } from '@/dialects'
import { column, defineTable, postgresDialect } from '@/index'

import {
  createMockPostgresConnector,
  createMockStatement,
} from '../helpers/nativePostgresClient'

import { registerDialectContractMember } from './dialectContractKit'
import type {
  DialectContractMemberCapabilities,
  QueryCompilerScenarios,
} from './dialectContractKit'
import type { DialectLifecycleContractRuntime } from './dialectMemberContract'
import {
  postgresCoordinationContractShard,
  postgresOperationSessionContractShard,
} from './postgresSharedShards'

const namespaceContext = {
  writableDefault: [
    { role: 'database' as const, spelling: 'contract_database' },
    { role: 'schema' as const, spelling: 'contract_schema' },
  ],
}

const postgresContractCapabilities = {
  identity: { state: 'supported', shard: 'semantic' },
  naming: { state: 'supported', shard: 'semantic' },
  desiredSchema: { state: 'supported', shard: 'semantic' },
  query: { state: 'supported', shard: 'semantic' },
  catalog: { state: 'supported', shard: 'semantic' },
  operationSession: { state: 'supported', shard: 'operation-session' },
  coordination: { state: 'supported', shard: 'coordination' },
  migration: { state: 'supported', shard: 'semantic' },
  lifecycle: { state: 'supported', shard: 'semantic' },
} as const satisfies DialectContractMemberCapabilities

const Records = defineTable(
  'records',
  {
    id: string(),
    label: string(),
    active: string(),
    amount: pipe(number(), column({ physicalType: { postgresql: 'integer' } })),
    deleted_at: string(),
    created_at: pipe(date(), column({ physicalType: { postgresql: 'timestamptz' } })),
  },
  { primaryKey: 'id' },
)
const Events = defineTable(
  'events',
  { id: string(), record_id: string(), label: string() },
  { primaryKey: 'id' },
)
const LifecycleRecords = defineTable(
  'lifecycle_records',
  { id: string(), label: string() },
  { primaryKey: 'id' },
)

const records = { relation: 'records' } as const
const events = { relation: 'events' } as const
const tenantEvents = {
  namespace: [{ role: 'schema' as const, spelling: 'tenant"quoted' }],
  relation: 'events"archive',
}

type SupportedQueryInput = Extract<
  QueryCompilerScenarios[keyof QueryCompilerScenarios]['support'],
  { state: 'supported' }
>['input']

const supported = (input: SupportedQueryInput) => ({
  support: { state: 'supported' as const, input },
})

const queryCompilerScenarios = {
  'select.projection': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
      selection: [
        { kind: 'column', column: 'label', alias: 'labelText' },
        { kind: 'column', column: 'id' },
      ],
    },
    expected: {
      sql: 'select "label" as "labelText", "id" from "contract_schema"."records" as "contract_database.contract_schema.records"',
      params: [],
    },
  }),
  'select.namespace': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: { kind: 'select', relation: tenantEvents, selection: [{ kind: 'all' }] },
    expected: {
      sql: 'select * from "tenant""quoted"."events""archive" as "tenant""quoted.events""archive"',
      params: [],
    },
  }),
  'select.join.inner': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
      selection: [
        { kind: 'column', relation: records, column: 'id' },
        { kind: 'column', relation: events, column: 'label' },
      ],
      joins: [
        {
          type: 'inner',
          relation: events,
          on: {
            kind: 'cmp',
            relation: records,
            column: 'id',
            op: 'eq',
            right: { relation: events, column: 'record_id' },
          },
        },
      ],
    },
    expected: {
      sql: 'select "contract_database.contract_schema.records"."id", "contract_database.contract_schema.events"."label" from "contract_schema"."records" as "contract_database.contract_schema.records" inner join "contract_schema"."events" as "contract_database.contract_schema.events" on "contract_database.contract_schema.records"."id" = "contract_database.contract_schema.events"."record_id"',
      params: [],
    },
  }),
  'select.join.left': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
      selection: [{ kind: 'all' }],
      joins: [
        {
          type: 'left',
          relation: events,
          on: {
            kind: 'cmp',
            relation: records,
            column: 'id',
            op: 'eq',
            right: { relation: events, column: 'record_id' },
          },
        },
      ],
    },
    expected: {
      sql: 'select * from "contract_schema"."records" as "contract_database.contract_schema.records" left join "contract_schema"."events" as "contract_database.contract_schema.events" on "contract_database.contract_schema.records"."id" = "contract_database.contract_schema.events"."record_id"',
      params: [],
    },
  }),
  'select.join.right': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
      selection: [{ kind: 'all' }],
      joins: [
        {
          type: 'right',
          relation: events,
          on: {
            kind: 'cmp',
            relation: records,
            column: 'id',
            op: 'eq',
            right: { relation: events, column: 'record_id' },
          },
        },
      ],
    },
    expected: {
      sql: 'select * from "contract_schema"."records" as "contract_database.contract_schema.records" right join "contract_schema"."events" as "contract_database.contract_schema.events" on "contract_database.contract_schema.records"."id" = "contract_database.contract_schema.events"."record_id"',
      params: [],
    },
  }),
  'predicate.comparisons': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
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
    },
    expected: {
      sql: 'select * from "contract_schema"."records" as "contract_database.contract_schema.records" where ("id" = $1 and "id" <> $2 and "id" > $3 and "id" >= $4 and "id" < $5 and "id" <= $6)',
      params: [1, 2, 3, 4, 5, 6],
    },
  }),
  'predicate.boolean': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
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
    },
    expected: {
      sql: 'select * from "contract_schema"."records" as "contract_database.contract_schema.records" where (not ("id" = $1 or ("id" > $2 and "id" < $3)))',
      params: [1, 2, 9],
    },
  }),
  'predicate.null': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
      selection: [{ kind: 'all' }],
      where: {
        kind: 'or',
        preds: [
          { kind: 'cmp', column: 'deleted_at', op: 'eq', value: null },
          { kind: 'cmp', column: 'deleted_at', op: 'neq', value: null },
        ],
      },
    },
    expected: {
      sql: 'select * from "contract_schema"."records" as "contract_database.contract_schema.records" where ("deleted_at" is null or "deleted_at" is not null)',
      params: [],
    },
  }),
  'expression.scalar': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
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
    },
    expected: {
      sql: 'select lower("label") as "lowered", upper("label") as "uppered", length("label") as "size", now() as "queriedAt", date_trunc($1, "created_at") as "day" from "contract_schema"."records" as "contract_database.contract_schema.records"',
      params: ['day'],
    },
  }),
  'expression.aggregate': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
      selection: [
        { kind: 'expr', expr: { kind: 'count_all' }, alias: 'total' },
        {
          kind: 'expr',
          expr: { kind: 'count', arg: { kind: 'column', column: 'id' } },
          alias: 'ids',
        },
        {
          kind: 'expr',
          expr: { kind: 'min', arg: { kind: 'column', column: 'amount' } },
          alias: 'smallest',
        },
        {
          kind: 'expr',
          expr: { kind: 'max', arg: { kind: 'column', column: 'amount' } },
          alias: 'largest',
        },
        {
          kind: 'expr',
          expr: { kind: 'sum', arg: { kind: 'column', column: 'amount' } },
          alias: 'sum',
        },
      ],
    },
    expected: {
      sql: 'select count(*) as "total", count("id") as "ids", min("amount") as "smallest", max("amount") as "largest", sum("amount") as "sum" from "contract_schema"."records" as "contract_database.contract_schema.records"',
      params: [],
    },
  }),
  'clause.group-having-order': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
      selection: [{ kind: 'column', column: 'active' }],
      groupBy: [{ column: 'active' }, { column: 'amount' }, { column: 'label' }],
      having: { kind: 'cmp', column: 'active', op: 'eq', value: 'yes' },
      orderBy: [
        { column: 'amount', direction: 'desc' },
        { column: 'label', direction: 'asc' },
      ],
    },
    expected: {
      sql: 'select "active" from "contract_schema"."records" as "contract_database.contract_schema.records" group by "active", "amount", "label" having "active" = $1 order by "amount" desc, "label" asc',
      params: ['yes'],
    },
  }),
  'clause.pagination': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'select',
      relation: records,
      selection: [{ kind: 'all' }],
      limit: 10,
      offset: 20,
    },
    expected: {
      sql: 'select * from "contract_schema"."records" as "contract_database.contract_schema.records" limit $1 offset $2',
      params: [10, 20],
    },
  }),
  'insert.rows-defaults-returning': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'insert',
      relation: records,
      columns: ['id', 'label', 'deleted_at'],
      values: [
        [1, 'first', undefined],
        [2, 'second', null],
      ],
      returning: { kind: 'columns', columns: ['id', 'label'] },
    },
    expected: {
      sql: 'insert into "contract_schema"."records" ("id", "label", "deleted_at") values ($1, $2, default), ($3, $4, $5) returning "id", "label"',
      params: [1, 'first', 2, 'second', null],
    },
  }),
  'update.set-where-returning': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'update',
      relation: records,
      set: [
        { column: 'label', value: 'updated' },
        { column: 'amount', value: 7 },
      ],
      where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
      allowAll: false,
      returning: { kind: 'all' },
    },
    expected: {
      sql: 'update "contract_schema"."records" as "contract_database.contract_schema.records" set "label" = $1, "amount" = $2 where "id" = $3 returning *',
      params: ['updated', 7, 1],
    },
  }),
  'delete.where-returning': supported({
    dialect: postgresDialect,
    handles: [Records, Events],
    registrationDefault: namespaceContext.writableDefault,
    node: {
      kind: 'delete',
      relation: records,
      where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
      allowAll: false,
      returning: { kind: 'columns', columns: ['id'] },
    },
    expected: {
      sql: 'delete from "contract_schema"."records" as "contract_database.contract_schema.records" where "id" = $1 returning "id"',
      params: [1],
    },
  }),
} satisfies QueryCompilerScenarios

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

function createPostgresLifecycleRuntime(): DialectLifecycleContractRuntime {
  let createdRelation: Readonly<{ schema: string; relation: string }> | undefined
  let selectedConnector: ReturnType<typeof createMockPostgresConnector> | undefined
  const operationCommands: OperationCommand[] = []
  const connector = createMockPostgresConnector({
    database: 'contract_database',
    currentSchema: 'contract_schema',
    onPrepare(sql) {
      selectedConnector = connector
      if (sql === 'select 1') operationCommands.push({ kind: 'ping' })
      if (sql === 'begin') operationCommands.push({ kind: 'begin' })
      if (sql === 'commit') operationCommands.push({ kind: 'commit' })

      const statement = createMockStatement(
        sql.includes('pg_try_advisory_lock')
          ? [{ locked: true }]
          : sql.includes('pg_advisory_unlock')
            ? [{ unlocked: true }]
            : sql.includes('current_database()')
              ? [
                  {
                    database: 'contract_database',
                    schema: 'contract_schema',
                    version: '160000',
                  },
                ]
              : sql.includes('"lifecycle_records"')
                ? [{ id: 'lifecycle-1', label: 'connector-selected' }]
                : [],
      )

      if (!/^create table "contract_schema"\."lifecycle_records"/i.test(sql)) {
        return statement
      }

      return {
        ...statement,
        async run() {
          createdRelation = {
            schema: 'contract_schema',
            relation: 'lifecycle_records',
          }
          return { success: true }
        },
      }
    },
  })
  return {
    dialect: postgresDialect,
    registerDialect: false,
    connector,
    schemas: [LifecycleRecords],
    executeQuery: (database: import('@/client').Db) =>
      database
        .from(LifecycleRecords)
        .where(LifecycleRecords.label, 'eq', 'connector-selected')
        .execute(),
    operationCommands,
    selectedConnector: () => selectedConnector,
    disposed: () => connector.disposed,
    queryParams: () =>
      connector.binds.find((params) => params.includes('connector-selected')),
    foreignPolicyLeak: () => false,
    directConnectorMethods: [],
    expected: {
      queryRows: [{ id: 'lifecycle-1', label: 'connector-selected' }],
      queryParam: 'connector-selected',
    },
    postMigrationState: () => ({ relation: createdRelation }),
    migration: {
      state: 'supported' as const,
      expectedPostMigrationState: {
        relation: { schema: 'contract_schema', relation: 'lifecycle_records' },
      },
      expectedPlan: {
        steps: [
          {
            kind: 'ensure_namespace',
            target: {
              kind: 'namespace',
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
                relation: {
                  spelling: 'lifecycle_records',
                  comparisonKey: 'lifecycle_records',
                },
              },
            },
          },
        ],
      } satisfies MigrationPlan,
    },
  }
}

registerDialectContractMember('PostgreSQL', postgresContractCapabilities, {
  semantic: {
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
              { name: 'active', dataType: 'text' },
              { name: 'amount', dataType: 'integer' },
              { name: 'deleted_at', dataType: 'text' },
              { name: 'created_at', dataType: 'timestamptz' },
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
          dialect: postgresDialect,
          handles: [Records, Events],
          target: Records,
          registrationDefault: namespaceContext.writableDefault,
          relation: records,
          column: 'label',
          node: queryCompilerScenarios['select.projection'].support.input.node,
          inspectCompiled: (query) => ({
            parameterCount: query.params.length,
            addressesRelation: query.sql.includes('"contract_schema"."records"'),
            addressesColumn: query.sql.includes('"label"'),
          }),
          expected: {
            relationMatches: ['records'],
            columnMatches: ['label'],
            compiled: {
              parameterCount: 0,
              addressesRelation: true,
              addressesColumn: true,
            },
          },
        },
      },
      scenarios: queryCompilerScenarios,
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
    lifecycle: {
      state: 'supported',
      input: createPostgresLifecycleRuntime,
    },
  },
  coordination: postgresCoordinationContractShard,
  'operation-session': postgresOperationSessionContractShard,
})
