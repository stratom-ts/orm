import { bigint, date, integer, number, pipe, string } from 'valibot'

import type { CompiledQuery, SqlAst } from '@/dialects'
import { sqliteDialect as sqliteContractDialect } from '@/dialects/sqlite'
import { defineTable } from '@/index'
import { extractStorageFacts } from '@/schemas/valibot/storageFacts'

import type { QueryCompilerScenarios } from './dialectContractKit'
import {
  createSqliteLifecycleRuntime,
  createSqliteMigrationCase,
  createSqliteUnsupportedCase,
} from './sqliteProductionFixtures'

const namespaceContext = {
  writableDefault: [{ role: 'database' as const, spelling: 'main' }],
}

const registrationDefault = namespaceContext.writableDefault

const Records = defineTable(
  'records',
  {
    id: pipe(number(), integer()),
    label: string(),
    active: string(),
    amount: pipe(number(), integer()),
    deleted_at: string(),
    created_at: date(),
  },
  { primaryKey: 'id' },
)

const Events = defineTable(
  'events',
  { id: string(), record_id: string(), label: string() },
  { primaryKey: 'id' },
)

const records = { relation: 'records' } as const
const events = { relation: 'events' } as const

type SupportedQueryInput = Extract<
  QueryCompilerScenarios[keyof QueryCompilerScenarios]['support'],
  { state: 'supported' }
>['input']

/** Wraps contract input in explicit supported-capability evidence. */
function supported(
  node: SqlAst,
  expected: Readonly<{ sql: string; params: readonly unknown[] }>,
) {
  return {
    support: {
      state: 'supported' as const,
      input: {
        dialect: sqliteContractDialect,
        handles: [Records, Events],
        registrationDefault,
        node,
        expected,
      } satisfies SupportedQueryInput,
    },
  }
}

/** Records adapter-level unsupported catalog evidence with its reason. */
function unsupported(node: SqlAst, expectedMessage: string) {
  return {
    support: {
      state: 'unsupported' as const,
      reason: `SQLite 3.37 does not support ${expectedMessage}`,
      input: {
        dialect: sqliteContractDialect,
        handles: [Records, Events],
        registrationDefault,
        node,
      },
      expectedMessage,
    },
  }
}

const queryCompilerScenarios = {
  'select.projection': supported(
    {
      kind: 'select',
      relation: records,
      selection: [
        { kind: 'column', column: 'label', alias: 'labelText' },
        { kind: 'column', column: 'id' },
      ],
    },
    {
      sql: 'select "label" as "labelText", "id" as "id" from "main"."records" as "main.records"',
      params: [],
    },
  ),
  'select.namespace': supported(
    {
      kind: 'select',
      relation: {
        namespace: [{ role: 'database', spelling: 'MAIN' }],
        relation: 'events"archive',
      },
      selection: [{ kind: 'all' }],
    },
    {
      sql: 'select * from "main"."events""archive" as "main.events""archive"',
      params: [],
    },
  ),
  'select.join.inner': supported(
    {
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
    {
      sql: 'select "main.records"."id" as "id", "main.events"."label" as "label" from "main"."records" as "main.records" inner join "main"."events" as "main.events" on "main.records"."id" = "main.events"."record_id"',
      params: [],
    },
  ),
  'select.join.left': supported(
    {
      kind: 'select',
      relation: records,
      selection: [
        { kind: 'column', relation: records, column: 'id', alias: 'recordId' },
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
    {
      sql: 'select "main.records"."id" as "recordId", "main.events"."id" as "eventId" from "main"."records" as "main.records" left join "main"."events" as "main.events" on "main.records"."id" = "main.events"."record_id"',
      params: [],
    },
  ),
  'select.join.right': unsupported(
    {
      kind: 'select',
      relation: records,
      selection: [{ kind: 'column', relation: records, column: 'id' }],
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
    'right joins',
  ),
  'predicate.comparisons': supported(
    {
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
    {
      sql: 'select "main.records"."id" as "id", "main.records"."label" as "label", "main.records"."active" as "active", "main.records"."amount" as "amount", "main.records"."deleted_at" as "deleted_at", "main.records"."created_at" as "created_at" from "main"."records" as "main.records" where ("id" = ? and "id" <> ? and "id" > ? and "id" >= ? and "id" < ? and "id" <= ?)',
      params: [1, 2, 3, 4, 5, 6],
    },
  ),
  'predicate.boolean': supported(
    {
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
    {
      sql: 'select "main.records"."id" as "id", "main.records"."label" as "label", "main.records"."active" as "active", "main.records"."amount" as "amount", "main.records"."deleted_at" as "deleted_at", "main.records"."created_at" as "created_at" from "main"."records" as "main.records" where (not ("id" = ? or ("id" > ? and "id" < ?)))',
      params: [1, 2, 9],
    },
  ),
  'predicate.null': supported(
    {
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
    {
      sql: 'select "main.records"."id" as "id", "main.records"."label" as "label", "main.records"."active" as "active", "main.records"."amount" as "amount", "main.records"."deleted_at" as "deleted_at", "main.records"."created_at" as "created_at" from "main"."records" as "main.records" where ("deleted_at" is null or "deleted_at" is not null)',
      params: [],
    },
  ),
  'expression.scalar': unsupported(
    {
      kind: 'select',
      relation: records,
      selection: [
        {
          kind: 'expr',
          alias: 'day',
          expr: {
            kind: 'date_trunc',
            unit: 'day',
            arg: { kind: 'column', column: 'created_at' },
          },
        },
      ],
    },
    'date_trunc',
  ),
  'expression.aggregate': supported(
    {
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
    {
      sql: 'select count(*) as "total", count("id") as "ids", min("amount") as "smallest", max("amount") as "largest", sum("amount") as "sum" from "main"."records" as "main.records"',
      params: [],
    },
  ),
  'clause.group-having-order': supported(
    {
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
    {
      sql: 'select "active" as "active" from "main"."records" as "main.records" group by "active", "amount", "label" having "active" = ? order by "amount" desc, "label" asc',
      params: ['yes'],
    },
  ),
  'clause.pagination': supported(
    {
      kind: 'select',
      relation: records,
      selection: [{ kind: 'all' }],
      limit: 10,
      offset: 20,
    },
    {
      sql: 'select "main.records"."id" as "id", "main.records"."label" as "label", "main.records"."active" as "active", "main.records"."amount" as "amount", "main.records"."deleted_at" as "deleted_at", "main.records"."created_at" as "created_at" from "main"."records" as "main.records" limit ? offset ?',
      params: [10, 20],
    },
  ),
  'insert.rows-defaults-returning': unsupported(
    {
      kind: 'insert',
      relation: records,
      columns: ['id', 'label', 'deleted_at'],
      values: [
        [1, 'first', undefined],
        [2, 'second', null],
      ],
      returning: { kind: 'columns', columns: ['id', 'label'] },
    },
    'DEFAULT as an individual VALUES expression',
  ),
  'update.set-where-returning': supported(
    {
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
    {
      sql: 'update "main"."records" as "main.records" set "label" = ?, "amount" = ? where "id" = ? returning "id" as "id", "label" as "label", "active" as "active", "amount" as "amount", "deleted_at" as "deleted_at", "created_at" as "created_at"',
      params: ['updated', 7, 1],
    },
  ),
  'delete.where-returning': supported(
    {
      kind: 'delete',
      relation: records,
      where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
      allowAll: false,
      returning: { kind: 'columns', columns: ['id'] },
    },
    {
      sql: 'delete from "main"."records" as "main.records" where "id" = ? returning "id" as "id"',
      params: [1],
    },
  ),
} satisfies QueryCompilerScenarios

export const sqliteSemanticContractInput = {
  identity: {
    dialect: sqliteContractDialect,
    context: namespaceContext,
    relation: { relation: 'RECORDS' },
    expected: {
      namespace: [
        {
          role: 'database',
          identifier: { spelling: 'main', comparisonKey: 'main' },
        },
      ],
      relation: { spelling: 'RECORDS', comparisonKey: 'records' },
    },
  },
  naming: {
    dialect: sqliteContractDialect,
    context: namespaceContext,
    owner: records,
    columns: ['label'],
    expectedName: 'records_label__325c0e5784db0e39_idx',
    collisionName: 'Contract_Collision_Idx',
  },
  desiredSchema: {
    dialect: sqliteContractDialect,
    context: namespaceContext,
    handles: [Records],
    expected: [
      {
        namespace: [{ role: 'database', spelling: 'main' }],
        relation: 'records',
        columns: [
          { name: 'id', dataType: 'INTEGER' },
          { name: 'label', dataType: 'TEXT' },
          { name: 'active', dataType: 'TEXT' },
          { name: 'amount', dataType: 'INTEGER' },
          { name: 'deleted_at', dataType: 'TEXT' },
          { name: 'created_at', dataType: 'DATETIME' },
        ],
        primaryKey: ['id'],
      },
    ],
  },
  query: {
    core: {
      dialect: sqliteContractDialect,
      handles: [Records, Events],
      target: Records,
      registrationDefault,
      relation: { relation: 'RECORDS' },
      column: 'LABEL',
      node: {
        kind: 'select',
        relation: records,
        selection: [{ kind: 'column', column: 'label' }],
      },
      /** Projects compiled SQL and bindings into the contract's assertion shape. */
      inspectCompiled: (query: CompiledQuery) => ({
        parameterCount: query.params.length,
        addressesMain: query.sql.includes('"main"."records"'),
        addressesColumn: query.sql.includes('"label"'),
      }),
      expected: {
        relationMatches: ['records'],
        columnMatches: ['label'],
        compiled: {
          parameterCount: 0,
          addressesMain: true,
          addressesColumn: true,
        },
      },
    },
    scenarios: queryCompilerScenarios,
    valueMapping: {
      dialect: sqliteContractDialect,
      scenarios: [
        {
          dataType: 'JSON',
          paramValue: { key: 'value' },
          resultValue: '{"key":"value"}',
          expected: {
            mappedParam: '{"key":"value"}',
            mappedResult: { key: 'value' },
          },
        },
        {
          dataType: 'BIGINT',
          context: { facts: extractStorageFacts(bigint()) },
          paramValue: 42n,
          resultValue: 42n,
          expected: { mappedParam: 42n, mappedResult: 42n },
        },
      ],
    },
  },
  catalog: {
    dialect: sqliteContractDialect,
    executor: {
      /** Executes fixture SQL with the configured native observations. */
      execute: async ({ sql }: { sql: string }) => {
        if (sql.includes('sqlite_version')) return [{ version: '3.45.0' }]

        if (sql.includes('pragma_database_list'))
          return [{ seq: 0, name: 'main', file: '' }]

        return []
      },
    },
    request: {
      relations: [],
      absentRelations: [],
      completeNamespaces: [namespaceContext.writableDefault],
    },
    expected: {
      sourceDialect: 'sqlite',
      writableDefault: namespaceContext.writableDefault,
      namespaceCoverage: { state: 'complete' },
      capabilities: {
        namespaces: { state: 'supported', fidelity: 'native' },
        relationOwner: {
          state: 'unsupported',
          by: 'engine',
          reason: 'SQLite has no relation owner',
        },
        identity: { state: 'supported', fidelity: 'native' },
        richObjects: { state: 'supported', fidelity: 'opaque' },
      },
      request: {
        relations: [],
        absentRelations: [],
        completeNamespaces: [
          namespaceContext.writableDefault.map((segment) => ({
            role: segment.role,
            spelling: segment.spelling,
          })),
        ],
      },
      namespaces: [
        {
          identity: namespaceContext.writableDefault.map((segment) => ({
            role: segment.role,
            spelling: segment.spelling,
          })),
          relationCoverage: { state: 'complete' },
          relations: [],
        },
      ],
    },
  },
  migration: {
    lowering: { createCase: createSqliteMigrationCase },
    unsupportedLowering: {
      state: 'supported',
      input: { createCase: createSqliteUnsupportedCase },
    },
  },
  lifecycle: createSqliteLifecycleRuntime,
} as const
