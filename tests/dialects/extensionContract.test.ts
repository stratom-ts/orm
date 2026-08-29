import type { Connector } from 'db0'
import { pipe, string } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerDialectForTest, resolveDialect } from '@/dialects/resolve'
import { column, createDatabase, defineTable } from '@/index'

import {
  EXTENSION_CONTRACT_DIALECT_ID,
  createExtensionContractCalls,
  createExtensionContractDialect,
} from '../helpers/extensionContractDialect'

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

describe('dialect extension contract', () => {
  it('routes the complete database lifecycle through one connector-selected member', async () => {
    const calls = createExtensionContractCalls()
    const member = createExtensionContractDialect(calls)
    unregister = registerDialectForTest(member)
    const { connector, directMethods, disposed } = createContractConnector()
    const Records = defineTable(
      'records',
      {
        id: pipe(
          string(),
          column({
            physicalType: { [EXTENSION_CONTRACT_DIALECT_ID]: 'fixture_id' },
          }),
        ),
        label: string(),
      },
      { primaryKey: 'id' },
    )
    const db = createDatabase({ connector, schemas: [Records] })

    expect(calls.connector).toBe(connector)
    await db.ping()
    const rows = await db
      .from(Records)
      .where(Records.label, 'eq', 'authored-value')
      .execute()
    expect(rows).toEqual([
      {
        id: 'fixture-result:row-1',
        label: 'fixture-result:stored-value',
      },
    ])
    expect(
      calls.statements.find((statement) => statement.sql === 'fixture query')?.params,
    ).toEqual(['fixture-param:authored-value'])

    await db.transaction(async (transaction) => {
      await transaction.ping()
      await transaction.transaction(async (nested) => nested.ping())
      await expect(
        transaction.transaction(async () => {
          throw new Error('nested contract rollback')
        }),
      ).rejects.toThrow('nested contract rollback')
    })
    await expect(
      db.transaction(async () => {
        throw new Error('root contract rollback')
      }),
    ).rejects.toThrow('root contract rollback')

    const dryRun = await db.migrate().dryRun()
    expect(dryRun.steps.length).toBeGreaterThan(0)
    await db.migrate().execute()
    await db.close()

    expect(calls.events).toEqual(
      expect.arrayContaining([
        'operations.createSessionProvider',
        'identity.create',
        'naming.generate',
        'naming.validate',
        'naming.createRegistry',
        'schema.lowerDesiredSchema',
        'schema.inferColumnType',
        'query.compile',
        'query.mapParamValue',
        'query.mapResultValue',
        'catalog.introspect',
        'migration.execute',
        'migration.lower',
        'migration.prepared',
        'session.open',
        'session.release:reuse',
        'sessionProvider.close',
      ]),
    )
    expect(calls.operationCommands).toEqual(
      expect.arrayContaining([
        { kind: 'ping' },
        { kind: 'begin' },
        { kind: 'commit' },
        { kind: 'rollback' },
        { kind: 'createSavepoint', id: 1 },
        { kind: 'releaseSavepoint', id: 1 },
        { kind: 'rollbackToSavepoint', id: 2 },
        { kind: 'releaseSavepoint', id: 2 },
      ]),
    )
    expect(calls.catalog?.capabilities.identity).toEqual({
      state: 'unsupported',
      by: 'engine',
      reason: 'The contract fixture deliberately has no identity generation',
    })
    expect(calls.statements.some(({ sql }) => /postgres|pg_|public/i.test(sql))).toBe(
      false,
    )
    expect(disposed()).toBe(true)
    expect(directMethods.getInstance).not.toHaveBeenCalled()
    expect(directMethods.exec).not.toHaveBeenCalled()
    expect(directMethods.prepare).not.toHaveBeenCalled()
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
