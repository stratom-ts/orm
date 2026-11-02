import type { Connector } from 'db0'
import { describe, expect, it } from 'vitest'

import type { Db } from '@/client'
import type { MigrationPlan } from '@/ddl/migrationPlan'
import type { CatalogSnapshot } from '@/dialects/catalog'
import { registerDialectForTest } from '@/dialects/resolve'
import type { Dialect, OperationCommand } from '@/dialects/types'
import { createDatabase } from '@/index'
import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import type { TableHandle } from '@/types'

type DialectLifecycleContractRuntime = Readonly<{
  dialect: Dialect
  registerDialect?: boolean
  connector: Connector
  schemas: readonly TableHandle[]
  defaultNamespace?: readonly NamespaceIdentifierInput[]
  /**
   * Executes query for the current fixture scenario.
   *
   * @param database - Native database identity or spelling used to scope fixture
   *   resources.
   *
   * @returns Rows produced by the representative public query operation.
   */
  executeQuery(database: Db): Promise<readonly unknown[]>
  operationCommands: OperationCommand[]
  /**
   * Builds catalog evidence for schema reconciliation checks.
   *
   * @returns Catalog evidence for schema reconciliation checks.
   */
  catalog?(): CatalogSnapshot | undefined
  /**
   * Returns the connector received by the selected dialect lifecycle facet.
   *
   * @returns The connector received by the selected dialect lifecycle facet.
   */
  selectedConnector(): Connector | undefined
  /**
   * Reports whether the fixture connector has been disposed.
   *
   * @returns True when the fixture connector has been disposed.
   */
  disposed(): boolean
  /**
   * Returns the recorded bindings of the representative fixture query.
   *
   * @returns The recorded bindings of the representative fixture query.
   */
  queryParams(): readonly unknown[] | undefined
  /**
   * Tests whether selected-member SQL accidentally includes another dialect's physical
   * policy.
   *
   * @returns True when selected-member SQL accidentally includes another dialect's
   *   physical policy.
   */
  foreignPolicyLeak(): boolean
  directConnectorMethods: readonly (() => unknown)[]
  expected: Readonly<{
    queryRows: readonly unknown[]
    queryParam: unknown
  }>
  /**
   * Returns recorded physical actions after the fixture migration completes.
   *
   * @returns Recorded physical actions after the fixture migration completes.
   */
  postMigrationState(): unknown
  migration:
    | Readonly<{
        state: 'supported'
        expectedPlan: MigrationPlan
        expectedPostMigrationState: unknown
        reportedOutcome?: Readonly<{
          expected: 'applied' | 'unchanged'
          observed: readonly ('applied' | 'unchanged')[]
        }>
      }>
    | Readonly<{
        state: 'unsupported'
        reason: string
        expectedPlan: MigrationPlan
        expectedPostMigrationState: unknown
      }>
}>

type DialectLifecycleContractFactory = () => DialectLifecycleContractRuntime

/**
 * Requires explicit reasons for unsupported or unavailable catalog capabilities.
 *
 * @param catalog - Observed catalog evidence used for desired-schema comparison.
 */
function expectExplicitCapabilityEvidence(catalog: CatalogSnapshot): void {
  for (const capability of Object.values(catalog.capabilities)) {
    if (capability.state === 'supported') continue

    expect(capability.state).toMatch(/unsupported|unavailable/)

    if ('reason' in capability) expect(capability.reason.trim().length).toBeGreaterThan(0)

    if (capability.state === 'unavailable' && capability.cause === 'version') {
      expect(capability.actual.length).toBeGreaterThan(0)
      expect(capability.requires.length).toBeGreaterThan(0)
    }
  }
}

/** Runs the single public connector-selected lifecycle smoke. */
async function runDialectLifecycleContract(
  runtime: DialectLifecycleContractRuntime,
): Promise<void> {
  const unregister =
    runtime.registerDialect === false
      ? undefined
      : registerDialectForTest(runtime.dialect)

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
    const plan = await database.migrate().plan()
    expect(plan).toEqual(runtime.migration.expectedPlan)

    await assertLifecycleMigration(runtime, database)

    await database.close()

    assertLifecycleCleanup(runtime)
  } finally {
    try {
      await closeDatabase?.()
    } finally {
      unregister?.()
    }
  }
}

/**
 * Checks connector ownership, capability evidence, and cleanup after the public lifecycle
 * scenario.
 *
 * @param runtime - Active operation and interruption controls shared by this run.
 */
function assertLifecycleCleanup(runtime: DialectLifecycleContractRuntime) {
  expect(runtime.selectedConnector()).toBe(runtime.connector)
  const catalog = runtime.catalog?.()

  if (catalog) expectExplicitCapabilityEvidence(catalog)

  expect(runtime.operationCommands).toEqual(
    expect.arrayContaining([{ kind: 'ping' }, { kind: 'begin' }, { kind: 'commit' }]),
  )

  expect(runtime.foreignPolicyLeak()).toBe(false)
  expect(runtime.disposed()).toBe(true)

  for (const method of runtime.directConnectorMethods) {
    expect(method).not.toHaveBeenCalled()
  }
}

/**
 * Checks supported or unsupported migration behavior and the reported post-migration
 * state.
 *
 * @param runtime - Active operation and interruption controls shared by this run.
 * @param database - Native database identity or spelling used to scope fixture resources.
 */
async function assertLifecycleMigration(
  runtime: DialectLifecycleContractRuntime,
  database: Db,
) {
  if (runtime.migration.state === 'supported') {
    await database.migrate().execute()
  } else {
    const error = await database
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'lowering',
      outcome: 'unchanged',
      capabilityIssues: [expect.objectContaining({ message: runtime.migration.reason })],
    })
  }

  const reportedOutcome =
    runtime.migration.state === 'supported'
      ? runtime.migration.reportedOutcome
      : undefined

  if (reportedOutcome) {
    expect(reportedOutcome.observed).toEqual([reportedOutcome.expected])
  }

  expect(await runtime.postMigrationState()).toEqual(
    runtime.migration.expectedPostMigrationState,
  )
}

/** Registers the single public connector-selected lifecycle smoke. */
function registerDialectLifecycleContract(
  name: string,
  createRuntime: DialectLifecycleContractFactory,
): void {
  describe(`${name} Dialect contract [lifecycle]`, () => {
    it('should route public work, migration, and cleanup through the selected member', async () => {
      await runDialectLifecycleContract(createRuntime())
    })
  })
}

export type { DialectLifecycleContractRuntime, DialectLifecycleContractFactory }

export { runDialectLifecycleContract, registerDialectLifecycleContract }
