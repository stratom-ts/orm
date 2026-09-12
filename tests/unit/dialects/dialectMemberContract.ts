import type { Connector } from 'db0'
import { describe, expect, it } from 'vitest'

import type { Db } from '@/client'
import type { CatalogSnapshot } from '@/dialects/catalog'
import { registerDialectForTest } from '@/dialects/resolve'
import type { Dialect, OperationCommand } from '@/dialects/types'
import { createDatabase } from '@/index'
import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import type { TableHandle } from '@/types'

export type DialectLifecycleContractRuntime = Readonly<{
  dialect: Dialect
  connector: Connector
  schemas: readonly TableHandle[]
  defaultNamespace?: readonly NamespaceIdentifierInput[]
  executeQuery(database: Db): Promise<readonly unknown[]>
  operationCommands: OperationCommand[]
  catalog(): CatalogSnapshot | undefined
  selectedConnector(): Connector | undefined
  disposed(): boolean
  queryParams(): readonly unknown[] | undefined
  foreignPolicyLeak(): boolean
  directConnectorMethods: readonly (() => unknown)[]
  expected: Readonly<{
    queryRows: readonly unknown[]
    queryParam: unknown
  }>
  migration:
    | Readonly<{ state: 'supported'; outcomes: Array<'applied' | 'unchanged'> }>
    | Readonly<{ state: 'unsupported'; reason: string }>
}>

export type DialectLifecycleContractFactory = () => DialectLifecycleContractRuntime

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

/** Registers the single public connector-selected lifecycle smoke. */
export function registerDialectLifecycleContract(
  name: string,
  createRuntime: DialectLifecycleContractFactory,
): void {
  describe(`${name} Dialect contract [lifecycle]`, () => {
    it('scenario [routes public work, migration, and cleanup through the selected member]', async () => {
      const runtime = createRuntime()
      const unregister = registerDialectForTest(runtime.dialect)
      let closeDatabase: (() => Promise<void>) | undefined

      try {
        const database = createDatabase({
          connector: runtime.connector,
          schemas: runtime.schemas,
          ...(runtime.defaultNamespace === undefined
            ? {}
            : { defaultNamespace: runtime.defaultNamespace }),
        })
        closeDatabase = () => database.close()
        await database.ping()
        const rows = await runtime.executeQuery(database)
        expect(rows).toEqual(runtime.expected.queryRows)
        expect(runtime.queryParams()).toEqual([runtime.expected.queryParam])

        await database.transaction(async (transaction) => transaction.ping())
        const dryRun = await database.migrate().dryRun()

        if (runtime.migration.state === 'supported') {
          await database.migrate().execute()
          expect(runtime.migration.outcomes).toEqual([
            dryRun.steps.length === 0 ? 'unchanged' : 'applied',
          ])
        } else {
          const error = await database
            .migrate()
            .execute()
            .catch((cause: unknown) => cause)
          expect(error).toMatchObject({
            _tag: 'MigrationError',
            stage: 'lowering',
            outcome: 'unchanged',
            capabilityIssues: [
              expect.objectContaining({ message: runtime.migration.reason }),
            ],
          })
        }

        await database.close()

        expect(runtime.selectedConnector()).toBe(runtime.connector)
        const catalog = runtime.catalog()
        expect(catalog).toBeDefined()
        if (!catalog) throw new Error('The lifecycle did not observe a catalog snapshot')

        expectExplicitCapabilityEvidence(catalog)
        expect(runtime.operationCommands).toEqual(
          expect.arrayContaining([
            { kind: 'ping' },
            { kind: 'begin' },
            { kind: 'commit' },
          ]),
        )
        expect(runtime.foreignPolicyLeak()).toBe(false)
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
  })
}
