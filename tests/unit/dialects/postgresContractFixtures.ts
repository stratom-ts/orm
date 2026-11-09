import { bigint, date, number, pipe, safeInteger, string } from 'valibot'

import type { Db } from '@/client'
import { planMigration } from '@/ddl/migrationPlan'
import type { MigrationPlan, PlannedMigration } from '@/ddl/migrationPlan'
import type { MigrationProgram } from '@/ddl/migrationProgram'
import type {
  CatalogExecutor,
  CatalogRequest,
  CompiledQuery,
  OperationCommand,
} from '@/dialects'
import { column, defineTable, postgresDialect } from '@/index'
import { extractStorageFacts } from '@/schemas/valibot/storageFacts'

import {
  applyPostgresFixtureDdl,
  postgresFixtureCatalogRows,
} from '../helpers/postgresDdlCatalog'

import type { MigrationContractCase, QueryCompilerScenarios } from './dialectContractKit'
import type { DialectLifecycleContractRuntime } from './dialectMemberContract'
import {
  createMockPostgresConnector,
  createMockStatement,
} from './postgresNativeClientFixtures'

const createPostgresLifecycleRuntimeData: MigrationPlan = {
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
}

const fixtureData: MigrationProgram = {
  atomicity: 'plan-atomic',
  preconditions: [
    {
      kind: 'column_has_no_nulls',
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
          spelling: 'records',
          comparisonKey: 'records',
        },
      },
      column: 'label',
      sourceStepIndexes: [0],
    },
  ],
  actions: [
    {
      sourceStepIndexes: [0],
      transaction: 'required',
      statements: [
        {
          sql: 'alter table "contract_schema"."records" alter column "label" set not null',
          params: [],
        },
      ],
    },
  ],
}

const namespaceContext = {
  writableDefault: [
    { role: 'database' as const, spelling: 'contract_database' },
    { role: 'schema' as const, spelling: 'contract_schema' },
  ],
}

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

/** Wraps contract input in explicit supported-capability evidence. */
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
      selection: [
        { kind: 'column', relation: records, column: 'id' },
        { kind: 'column', relation: events, column: 'id', alias: 'eventId' },
      ],
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
      sql: 'select "contract_database.contract_schema.records"."id", "contract_database.contract_schema.events"."id" as "eventId" from "contract_schema"."records" as "contract_database.contract_schema.records" left join "contract_schema"."events" as "contract_database.contract_schema.events" on "contract_database.contract_schema.records"."id" = "contract_database.contract_schema.events"."record_id"',
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
      selection: [
        { kind: 'column', relation: records, column: 'id' },
        { kind: 'column', relation: events, column: 'id', alias: 'eventId' },
      ],
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
      sql: 'select "contract_database.contract_schema.records"."id", "contract_database.contract_schema.events"."id" as "eventId" from "contract_schema"."records" as "contract_database.contract_schema.records" right join "contract_schema"."events" as "contract_database.contract_schema.events" on "contract_database.contract_schema.records"."id" = "contract_database.contract_schema.events"."record_id"',
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
      sql: 'select "contract_database.contract_schema.records"."id" as "id", "contract_database.contract_schema.records"."label" as "label", "contract_database.contract_schema.records"."active" as "active", "contract_database.contract_schema.records"."amount" as "amount", "contract_database.contract_schema.records"."deleted_at" as "deleted_at", "contract_database.contract_schema.records"."created_at" as "created_at" from "contract_schema"."records" as "contract_database.contract_schema.records" where ("id" = $1 and "id" <> $2 and "id" > $3 and "id" >= $4 and "id" < $5 and "id" <= $6)',
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
      sql: 'select "contract_database.contract_schema.records"."id" as "id", "contract_database.contract_schema.records"."label" as "label", "contract_database.contract_schema.records"."active" as "active", "contract_database.contract_schema.records"."amount" as "amount", "contract_database.contract_schema.records"."deleted_at" as "deleted_at", "contract_database.contract_schema.records"."created_at" as "created_at" from "contract_schema"."records" as "contract_database.contract_schema.records" where (not ("id" = $1 or ("id" > $2 and "id" < $3)))',
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
      sql: 'select "contract_database.contract_schema.records"."id" as "id", "contract_database.contract_schema.records"."label" as "label", "contract_database.contract_schema.records"."active" as "active", "contract_database.contract_schema.records"."amount" as "amount", "contract_database.contract_schema.records"."deleted_at" as "deleted_at", "contract_database.contract_schema.records"."created_at" as "created_at" from "contract_schema"."records" as "contract_database.contract_schema.records" where ("deleted_at" is null or "deleted_at" is not null)',
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
      sql: 'select "contract_database.contract_schema.records"."id" as "id", "contract_database.contract_schema.records"."label" as "label", "contract_database.contract_schema.records"."active" as "active", "contract_database.contract_schema.records"."amount" as "amount", "contract_database.contract_schema.records"."deleted_at" as "deleted_at", "contract_database.contract_schema.records"."created_at" as "created_at" from "contract_schema"."records" as "contract_database.contract_schema.records" limit $1 offset $2',
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
      sql: 'update "contract_schema"."records" as "contract_database.contract_schema.records" set "label" = $1, "amount" = $2 where "id" = $3 returning "id", "label", "active", "amount", "deleted_at", "created_at"',
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

const contractCatalogRequest: CatalogRequest = {
  relations: [
    {
      relation: {
        namespace: [{ role: 'schema', spelling: 'contract_schema' }],
        relation: 'present_records',
      },
      shape: 'complete',
    },
  ],
  absentRelations: [
    {
      namespace: [{ role: 'schema', spelling: 'contract_schema' }],
      relation: 'absent_records',
    },
  ],
  completeNamespaces: [[{ role: 'schema', spelling: 'contract_empty' }]],
}

const contractCatalogExecutor: CatalogExecutor = {
  /**
   * Executes the compiled query through its owning session or executor.
   *
   * @param options - Resolved operation inputs, including sql.
   *
   * @returns The execute observations in their required order.
   */
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

    if (sql.includes('-- catalog:namespace')) {
      return [
        { schema: 'contract_schema', owner: 'contract_owner' },
        { schema: 'contract_empty', owner: 'contract_owner' },
      ]
    }

    if (sql.includes('as relation_kind')) {
      return [
        {
          object_id: '1',
          schema: 'contract_schema',
          name: 'present_records',
          relation_kind: 'r',
          persistence: 'p',
          owner: 'contract_owner',
          native_definition: null,
          options: [],
          partition_key: null,
          row_level_security: false,
          force_row_level_security: false,
          replica_identity: 'd',
          access_method: 'heap',
          tablespace: null,
          is_partition: false,
          partition_bound: null,
        },
      ]
    }

    return []
  },
}

/**
 * Creates the postgres lifecycle runtime fixture used by the contract scenario.
 *
 * @returns The postgres lifecycle runtime fixture used by the contract scenario.
 */
function createPostgresLifecycleRuntime(): DialectLifecycleContractRuntime {
  const state: PostgresLifecycleFixtureState = {
    createdRelation: undefined,
    selectedConnector: undefined,
  }

  const operationCommands: OperationCommand[] = []
  const tables: Parameters<typeof applyPostgresFixtureDdl>[1] = []
  const connector = createMockPostgresConnector({
    database: 'contract_database',
    currentSchema: 'contract_schema',
    /** Dispatches prepared fixture SQL and records lifecycle commands. */
    onPrepare: (sql) =>
      prepareObservedLifecycleStatement(sql, state, connector, operationCommands, tables),
  })

  return {
    dialect: postgresDialect,
    registerDialect: false,
    connector,
    schemas: [LifecycleRecords],
    /** Executes query for the current fixture scenario. */
    executeQuery: (database: Db) =>
      database
        .from(LifecycleRecords)
        .where(LifecycleRecords.label, 'eq', 'connector-selected')
        .execute(),
    operationCommands,
    /** Returns the connector received by the selected dialect lifecycle facet. */
    selectedConnector: () => state.selectedConnector,
    /** Reports whether the fixture connector has been disposed. */
    disposed: () => connector.disposed,
    /** Returns bindings recorded for the representative query. */
    queryParams: () =>
      connector.binds.find((params) => params.includes('connector-selected')),
    /** Detects another dialect's physical policy in fixture SQL. */
    foreignPolicyLeak: () => false,
    directConnectorMethods: [],
    expected: createPostgresLifecycleExpectation(),
    /** Returns physical actions recorded after fixture migration. */
    postMigrationState: () => ({ relation: state.createdRelation }),
    migration: {
      state: 'supported' as const,
      expectedPostMigrationState: {
        relation: { schema: 'contract_schema', relation: 'lifecycle_records' },
      },
      expectedPlan: structuredClone(
        createPostgresLifecycleRuntimeData,
      ) satisfies MigrationPlan,
    },
  }
}

const postgresSemanticContractInput = {
  identity: {
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
  naming: {
    dialect: postgresDialect,
    context: namespaceContext,
    owner: { relation: 'records' },
    columns: ['label'],
    expectedName: 'records_label__8049ce336585d5ab_idx',
    collisionName: 'contract_collision_idx',
  },
  desiredSchema: {
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
  query: {
    core: {
      dialect: postgresDialect,
      handles: [Records, Events],
      target: Records,
      registrationDefault: namespaceContext.writableDefault,
      relation: records,
      column: 'label',
      node: queryCompilerScenarios['select.projection'].support.input.node,
      /** Projects compiled SQL and bindings into the contract's assertion shape. */
      inspectCompiled: (query: CompiledQuery) => ({
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
    scenarios: queryCompilerScenarios,
    valueMapping: {
      dialect: postgresDialect,
      scenarios: [
        {
          dataType: 'jsonb',
          paramValue: { key: 'value' },
          resultValue: '{"key":"value"}',
          expected: {
            mappedParam: '{"key":"value"}',
            mappedResult: { key: 'value' },
          },
        },
        {
          dataType: 'numeric',
          context: { facts: extractStorageFacts(bigint()) },
          paramValue: 9007199254740993n,
          resultValue: '9007199254740993',
          expected: {
            mappedParam: '9007199254740993',
            mappedResult: 9007199254740993n,
          },
        },
        {
          dataType: 'bigint',
          context: { facts: extractStorageFacts(pipe(number(), safeInteger())) },
          paramValue: 42,
          resultValue: '42',
          expected: { mappedParam: 42, mappedResult: 42 },
        },
      ],
    },
  },
  catalog: {
    dialect: postgresDialect,
    executor: contractCatalogExecutor,
    request: contractCatalogRequest,
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
      request: {
        relations: [
          {
            identity: {
              namespace: [
                { role: 'database', spelling: 'contract_database' },
                { role: 'schema', spelling: 'contract_schema' },
              ],
              relation: 'present_records',
            },
            shape: 'complete',
          },
        ],
        absentRelations: [
          {
            namespace: [
              { role: 'database', spelling: 'contract_database' },
              { role: 'schema', spelling: 'contract_schema' },
            ],
            relation: 'absent_records',
          },
        ],
        completeNamespaces: [
          [
            { role: 'database', spelling: 'contract_database' },
            { role: 'schema', spelling: 'contract_empty' },
          ],
        ],
      },
      namespaces: [
        {
          identity: [
            { role: 'database', spelling: 'contract_database' },
            { role: 'schema', spelling: 'contract_empty' },
          ],
          relationCoverage: { state: 'complete' },
          relations: [],
        },
        {
          identity: [
            { role: 'database', spelling: 'contract_database' },
            { role: 'schema', spelling: 'contract_schema' },
          ],
          relationCoverage: {
            state: 'partial',
            remainder: {
              state: 'unmanaged',
              reason: 'Relations outside the requested catalog scope are unmanaged',
            },
          },
          relations: [
            {
              namespace: [
                { role: 'database', spelling: 'contract_database' },
                { role: 'schema', spelling: 'contract_schema' },
              ],
              relation: 'present_records',
            },
          ],
        },
      ],
    },
  },
  migration: {
    lowering: {
      /**
       * Creates the case fixture used by the contract scenario.
       *
       * @returns The case fixture used by the contract scenario.
       */
      async createCase() {
        const migrationCatalogRequest: CatalogRequest = {
          relations: [{ relation: { relation: 'records' }, shape: 'complete' }],
          absentRelations: [],
          completeNamespaces: [],
        }

        const catalog = await postgresDialect.catalog.introspectCatalog(
          contractCatalogExecutor,
          migrationCatalogRequest,
        )

        const base = planMigration([Records], catalog, postgresDialect.migration.planning)

        const relation = base.identities.resolve({ relation: 'records' })
        const planned = {
          ...base,
          plan: {
            steps: [
              {
                kind: 'set_not_null' as const,
                target: {
                  kind: 'column' as const,
                  relation,
                  column: base.identities.member('column', 'label'),
                },
              },
            ],
          },
        }

        const profile = base.profile
        return {
          dialect: postgresDialect,
          planned,
          profile,
          mismatchedProfiles: {
            identityAdapter: createIdentityAdapterMismatch(profile),
            namespaceContext: createNamespaceContextMismatch(profile),
            registrationDefault: createRegistrationDefaultMismatch(profile),
          },
          expectedProgram: structuredClone(fixtureData),
        }
      },
    },
    unsupportedLowering: {
      state: 'supported',
      input: {
        /** Creates a valid step followed by an invalid database target. */
        async createCase() {
          const migrationCatalogRequest: CatalogRequest = {
            relations: [{ relation: { relation: 'records' }, shape: 'complete' }],
            absentRelations: [],
            completeNamespaces: [],
          }

          const catalog = await postgresDialect.catalog.introspectCatalog(
            contractCatalogExecutor,
            migrationCatalogRequest,
          )

          const base = planMigration(
            [Records],
            catalog,
            postgresDialect.migration.planning,
          )

          return {
            dialect: postgresDialect,
            planned: withInvalidPostgresTarget(base),
            profile: base.profile,
            issue: {
              code: 'invalid_target' as const,
              message:
                'Migration target namespace database "other_database" does not match executing database "contract_database"',
              sourceStepIndexes: [1],
            },
          }
        },
      },
    },
  },
  lifecycle: createPostgresLifecycleRuntime,
} as const

/** Adds one valid step before a target rejected by PostgreSQL lowering. */
function withInvalidPostgresTarget(base: PlannedMigration): PlannedMigration {
  const relation = base.identities.resolve({ relation: 'records' })
  const invalidRelation = {
    ...relation,
    namespace: relation.namespace.map((segment, index) =>
      index === 0
        ? {
            ...segment,
            identifier: {
              ...segment.identifier,
              spelling: 'other_database',
              comparisonKey: 'other_database',
            },
          }
        : segment,
    ),
  }

  const column = base.identities.member('column', 'label')

  return {
    ...base,
    plan: {
      steps: [
        { kind: 'set_not_null', target: { kind: 'column', relation, column } },
        {
          kind: 'set_not_null',
          target: { kind: 'column', relation: invalidRelation, column },
        },
      ],
    },
  }
}

/** Creates the identity adapter mismatch fixture used by the contract scenario. */
function createIdentityAdapterMismatch(
  profile: MigrationContractCase['profile'],
): MigrationContractCase['mismatchedProfiles']['identityAdapter'] {
  return {
    profile: {
      ...profile,
      identityAdapter: 'contract-other-identity',
    },
    issues: [
      {
        code: 'profile_mismatch',
        message:
          "Executing profile adapter 'contract-other-identity' does not match PostgreSQL",
        sourceStepIndexes: [],
      },
      {
        code: 'profile_mismatch',
        message:
          "Identity adapter 'postgresql' does not match executing adapter 'contract-other-identity'",
        sourceStepIndexes: [],
      },
    ],
  }
}

/** Creates the namespace context mismatch fixture used by the contract scenario. */
function createNamespaceContextMismatch(
  profile: MigrationContractCase['profile'],
): MigrationContractCase['mismatchedProfiles']['namespaceContext'] {
  return {
    profile: {
      ...profile,
      namespaceContext: {
        writableDefault: [
          { role: 'database', spelling: 'contract_database' },
          { role: 'schema', spelling: 'other_schema' },
        ],
      },
    },
    issues: [
      {
        code: 'profile_mismatch',
        message: 'Writable namespace context does not match the executing session',
        sourceStepIndexes: [],
      },
    ],
  }
}

/** Creates the registration default mismatch fixture used by the contract scenario. */
function createRegistrationDefaultMismatch(
  profile: MigrationContractCase['profile'],
): MigrationContractCase['mismatchedProfiles']['registrationDefault'] {
  return {
    profile: {
      ...profile,
      registrationDefault: [{ role: 'schema', spelling: 'other_schema' }],
    },
    issues: [
      {
        code: 'profile_mismatch',
        message: 'Registration default does not match the executing configuration',
        sourceStepIndexes: [],
      },
    ],
  }
}

type PostgresLifecycleFixtureState = {
  createdRelation: Readonly<{ schema: string; relation: string }> | undefined
  selectedConnector: ReturnType<typeof createMockPostgresConnector> | undefined
}

/**
 * Prepares lifecycle statement for the current fixture scenario.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 * @param state - Mutable fixture state shared across observed calls and cleanup.
 * @param connector - Connector that owns native connection resources.
 * @param operationCommands - Recorded transaction and savepoint SQL commands.
 *
 * @returns The fixture statement with lifecycle observations attached where required.
 */
function prepareLifecycleStatement(
  sql: string,
  state: PostgresLifecycleFixtureState,
  connector: ReturnType<typeof createMockPostgresConnector>,
  operationCommands: OperationCommand[],
) {
  state.selectedConnector = connector

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
    /** Runs a fixture statement with configured outcomes. */
    async run() {
      state.createdRelation = {
        schema: 'contract_schema',
        relation: 'lifecycle_records',
      }
      return { success: true }
    },
  }
}

/**
 * Builds expected mapped rows and parameter evidence for the lifecycle query.
 *
 * @returns Expected lifecycle query results and bindings.
 */
function createPostgresLifecycleExpectation() {
  return {
    queryRows: [{ id: 'lifecycle-1', label: 'connector-selected' }],
    queryParam: 'connector-selected',
  }
}

/** Keeps the lifecycle fixture catalog consistent with successful DDL. */
function prepareObservedLifecycleStatement(
  sql: string,
  state: PostgresLifecycleFixtureState,
  connector: ReturnType<typeof createMockPostgresConnector>,
  operationCommands: OperationCommand[],
  tables: Parameters<typeof applyPostgresFixtureDdl>[1],
) {
  const rows = postgresFixtureCatalogRows(sql, tables)

  if (rows) return createMockStatement(rows)

  const statement = prepareLifecycleStatement(sql, state, connector, operationCommands)

  const run = statement.run.bind(statement)
  return {
    ...statement,
    run: async () => {
      const result = await run()
      applyPostgresFixtureDdl(sql, tables)
      return result
    },
  }
}

export { postgresSemanticContractInput }
