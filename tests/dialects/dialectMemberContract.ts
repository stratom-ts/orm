import type { Connector } from 'db0'
import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import type { CatalogSnapshot } from '@/dialects/catalog'
import { registerDialectForTest } from '@/dialects/resolve'
import type { Dialect, OperationCommand } from '@/dialects/types'
import { column, createDatabase, defineTable } from '@/index'

export type DialectMemberContractRuntime = Readonly<{
  dialect: Dialect
  connector: Connector
  events: string[]
  operationCommands: OperationCommand[]
  statements: Array<{ sql: string; params: unknown[] }>
  catalog(): CatalogSnapshot | undefined
  selectedConnector(): Connector | undefined
  disposed(): boolean
  directConnectorMethods: readonly (() => unknown)[]
  expected: Readonly<{
    queryRows: readonly unknown[]
    querySql: string
    queryParam: unknown
    pingSql: string
    forbiddenSql?: RegExp
  }>
  migration:
    | Readonly<{ state: 'supported'; outcomes: Array<'applied' | 'unchanged'> }>
    | Readonly<{ state: 'unsupported'; reason: string }>
}>

export type DialectMemberContractFactory = () => DialectMemberContractRuntime

function expectExplicitCapabilityEvidence(catalog: CatalogSnapshot): void {
  for (const capability of Object.values(catalog.capabilities)) {
    if (capability.state === 'supported') continue

    expect(capability.state).toMatch(/unsupported|unavailable/)
    if ('reason' in capability) expect(capability.reason.length).toBeGreaterThan(0)

    if (capability.state === 'unavailable' && capability.cause === 'version') {
      expect(capability.actual.length).toBeGreaterThan(0)
      expect(capability.requires.length).toBeGreaterThan(0)
    }
  }
}

/**
 * Registers the observable contract shared by complete connector-selected members.
 *
 * A runtime exposes semantic observations, not database-specific SQL assertions. An
 * adapter may advertise migration as unsupported; catalog gaps must still carry tagged
 * evidence.
 */
export function registerDialectMemberContract(
  name: string,
  createRuntime: DialectMemberContractFactory,
): void {
  describe(`${name} Dialect member contract`, () => {
    it('routes the complete database lifecycle through the connector-selected member', async () => {
      const runtime = createRuntime()
      const unregister = registerDialectForTest(runtime.dialect)
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
      let closeDatabase: (() => Promise<void>) | undefined

      try {
        const db = createDatabase({ connector: runtime.connector, schemas: [Records] })
        closeDatabase = () => db.close()
        await db.ping()
        const rows = await db
          .from(Records)
          .where(Records.label, 'eq', 'authored-value')
          .execute()

        expect(rows).toEqual(runtime.expected.queryRows)
        expect(
          runtime.statements.find(({ sql }) => sql === runtime.expected.querySql)?.params,
        ).toEqual([runtime.expected.queryParam])

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

        if (runtime.migration.state === 'supported') {
          await db.migrate().execute()
        } else {
          await expect(db.migrate().execute()).rejects.toThrow(runtime.migration.reason)
        }

        await db.close()

        expect(runtime.selectedConnector()).toBe(runtime.connector)
        expect(runtime.events).toEqual(
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
            'session.open',
            'session.release:reuse',
            'sessionProvider.close',
          ]),
        )

        if (runtime.migration.state === 'supported') {
          expect(runtime.events).toEqual(
            expect.arrayContaining([
              'catalog.introspect',
              'migration.execute',
              'migration.lower',
              'migration.prepared',
            ]),
          )
        }

        expect(runtime.operationCommands).toEqual(
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
        const catalog = runtime.catalog()
        expect(catalog).toBeDefined()
        expectExplicitCapabilityEvidence(catalog!)

        const forbiddenSql = runtime.expected.forbiddenSql

        if (forbiddenSql) {
          expect(runtime.statements.some(({ sql }) => forbiddenSql.test(sql))).toBe(false)
        }

        expect(runtime.disposed()).toBe(true)

        for (const method of runtime.directConnectorMethods) {
          expect(method).not.toHaveBeenCalled()
        }
      } finally {
        try {
          await closeDatabase?.()
        } finally {
          unregister()
        }
      }
    })

    it('keeps an explicit session provider execution-only', async () => {
      const runtime = createRuntime()
      const unregister = registerDialectForTest(runtime.dialect)
      const overrideStatements: string[] = []
      const provider = {
        nativeTransactions: true as const,
        async open() {
          return {
            identity: { database: 'override_db', physicalSession: 'override-session' },
            async query(query: { sql: string }) {
              overrideStatements.push(query.sql)
              return []
            },
            async run(query: { sql: string }) {
              overrideStatements.push(query.sql)
            },
            async cancel() {},
            async release() {},
          }
        },
        async close() {},
      }
      let closeDatabase: (() => Promise<void>) | undefined

      try {
        const db = createDatabase({
          connector: runtime.connector,
          operationSessionProvider: provider,
          schemas: [],
        })
        closeDatabase = () => db.close()
        await db.ping()
        await db.close()

        expect(overrideStatements).toEqual([runtime.expected.pingSql])
        expect(runtime.operationCommands).toContainEqual({ kind: 'ping' })
        expect(runtime.events).not.toContain('operations.createSessionProvider')
      } finally {
        try {
          await closeDatabase?.()
        } finally {
          unregister()
        }
      }
    })

    it('reports applied and unchanged migration outcomes when advertised', async () => {
      const executeScenario = async (
        expected: 'applied' | 'unchanged',
      ): Promise<boolean> => {
        const runtime = createRuntime()

        if (runtime.migration.state === 'unsupported') {
          await runtime.connector.dispose?.()
          return false
        }

        const unregister = registerDialectForTest(runtime.dialect)
        const Records = defineTable(
          `migration_records_${expected}`,
          {
            id: pipe(string(), column({ physicalType: { [runtime.dialect.id]: 'id' } })),
          },
          { primaryKey: 'id' },
        )
        let closeDatabase: (() => Promise<void>) | undefined

        try {
          const db = createDatabase({
            connector: runtime.connector,
            schemas: expected === 'applied' ? [Records] : [],
          })
          closeDatabase = () => db.close()
          await db.migrate().execute()
          expect(runtime.migration.outcomes).toEqual([expected])
          return true
        } finally {
          try {
            await closeDatabase?.()
          } finally {
            unregister()
          }
        }
      }

      if (!(await executeScenario('applied'))) return
      expect(await executeScenario('unchanged')).toBe(true)
    })
  })
}
