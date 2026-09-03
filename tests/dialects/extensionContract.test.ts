import type { Connector } from 'db0'
import { pipe, string } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerDialectForTest, resolveDialect } from '@/dialects/resolve'
import { column, createDatabase, defineTable } from '@/index'

import {
  EXTENSION_CONTRACT_DIALECT_ID,
  EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON,
  createExtensionContractCalls,
  createExtensionContractDialect,
} from '../helpers/extensionContractDialect'

import {
  assertDialectQueryAgreement,
  registerDialectMemberContract,
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

function createContractRuntime(migration: 'supported' | 'unsupported') {
  const calls = createExtensionContractCalls()
  const dialect = createExtensionContractDialect(calls, { migration })
  const { connector, directMethods, disposed } = createContractConnector()
  return {
    dialect,
    connector,
    events: calls.events,
    operationCommands: calls.operationCommands,
    statements: calls.statements,
    catalog: () => calls.catalog,
    selectedConnector: () => calls.connector,
    disposed,
    directConnectorMethods: Object.values(directMethods),
    expected: {
      queryRows: [
        {
          id: 'fixture-result:fixture_tenant.records.id:row-1',
          label:
            'fixture-result:fixture_tenant.records.label:fixture-param:authored-value',
        },
      ],
      querySql:
        'fixture query:{"database":"fixture_tenant","relation":"records","columns":[{"output":"id","physical":"id"},{"output":"label","physical":"label"}],"parameterColumns":["label"]}',
      queryParam: 'fixture-param:authored-value',
      pingSql: 'fixture operation ping',
      forbiddenSql: /postgres|pg_|public/i,
      memberComparison: 'caseFolded' as const,
      registrationDefault: [{ role: 'database' as const, spelling: 'fixture_tenant' }],
    },
    migration:
      migration === 'supported'
        ? { state: 'supported' as const, outcomes: calls.migrationOutcomes }
        : {
            state: 'unsupported' as const,
            reason: EXTENSION_CONTRACT_UNSUPPORTED_MIGRATION_REASON,
          },
  }
}

registerDialectMemberContract('minimal non-PostgreSQL', () =>
  createContractRuntime('supported'),
)

registerDialectMemberContract('explicitly migration-limited', () =>
  createContractRuntime('unsupported'),
)

describe('dialect extension contract', () => {
  it('rejects a compiler that disagrees with the reusable Query agreement case', async () => {
    const runtime = createContractRuntime('supported')
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
      expect(() => assertDialectQueryAgreement(mismatched, rows)).toThrow()
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
