import { boolean, integer, number, pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Db, TableHandle } from '@/index'
import { DriverError, column, defineTable, excluded } from '@/index'

const integrationCapabilityNames = [
  'lifecycle',
  'query',
  'transaction',
  'migration',
  'convergence',
] as const

type IntegrationCapabilityName = (typeof integrationCapabilityNames)[number]

type IntegrationCapability =
  | Readonly<{ state: 'supported' }>
  | Readonly<{ state: 'unsupported'; reason: string }>

export type IntegrationScenarioRegistrar = (
  title: string,
  test: () => Promise<void>,
) => void

export interface DialectIntegrationAdapter {
  readonly name: string
  readonly dialectId: string
  readonly capabilities: Readonly<
    Record<IntegrationCapabilityName, IntegrationCapability>
  >
  /** Checks that the integration database is available before contract scenarios run. */
  readiness(): Promise<void>
  /**
   * Runs the shared integration scenario with the adapter's isolated database client.
   *
   * @param schemas - Registered table handles defining the desired schema.
   * @param callback - Work to run within the owned client or session scope.
   *
   * @returns The callback value after the operation and required cleanup complete.
   */
  withDatabase<const TSchemas extends readonly TableHandle[], TResult>(
    schemas: TSchemas,
    callback: (context: Readonly<{ db: Db<TSchemas> }>) => Promise<TResult>,
  ): Promise<TResult>
}

/** Rejects incomplete or unexplained integration capability declarations. */
export function validateDialectIntegrationCapabilities(
  capabilities: Readonly<Record<IntegrationCapabilityName, IntegrationCapability>>,
): void {
  for (const name of integrationCapabilityNames) {
    const capability = (
      capabilities as Partial<Record<IntegrationCapabilityName, IntegrationCapability>>
    )[name]

    if (!capability) {
      throw new Error(`Integration capability declaration omits ${name}`)
    }

    if (capability.state === 'unsupported' && capability.reason.trim().length === 0) {
      throw new Error(`Integration capability ${name} needs a non-empty reason`)
    }
  }
}

const ContractRecords = defineTable(
  'contract_records',
  {
    id: pipe(
      number(),
      integer(),
      column({ generation: { kind: 'identity', mode: 'byDefault' } }),
    ),
    label: string(),
    active: pipe(
      boolean(),
      column({ databaseDefault: { kind: 'literal', value: true } }),
    ),
  },
  { primaryKey: 'id', indexes: [{ columns: ['label'], unique: true }] },
)

const ContractScopedRecords = defineTable(
  'contract_scoped_records',
  {
    id: pipe(
      number(),
      integer(),
      column({ generation: { kind: 'identity', mode: 'byDefault' } }),
    ),
    scope: string(),
    key: string(),
    value: string(),
  },
  {
    primaryKey: 'id',
    indexes: [{ columns: ['scope', 'key'], unique: true }],
  },
)

/** Returns whether every capability required for an integration scenario is supported. */
export function shouldRegisterDialectIntegrationScenario(
  capabilities: DialectIntegrationAdapter['capabilities'],
  required: readonly IntegrationCapabilityName[],
): boolean {
  return !required.some((capability) => capabilities[capability].state === 'unsupported')
}

/** Registers dialect integration scenario checks against the selected dialect contract. */
export function registerDialectIntegrationScenario(
  adapter: Pick<DialectIntegrationAdapter, 'capabilities'>,
  capabilities: readonly IntegrationCapabilityName[],
  title: string,
  test: () => Promise<void>,
  register: IntegrationScenarioRegistrar = (scenarioTitle, scenarioTest) =>
    it(scenarioTitle, scenarioTest),
): void {
  // Unsupported capabilities do not register a scenario. This keeps the suite
  // free of skipped tests while the adapter capability declaration remains the
  // source of truth for the omitted behavior.
  if (!shouldRegisterDialectIntegrationScenario(adapter.capabilities, capabilities))
    return

  register(title, test)
}

/** Registers public, reusable integration behavior for one complete Dialect member. */
export function registerDialectIntegrationScenarios(
  adapter: DialectIntegrationAdapter,
): void {
  validateDialectIntegrationCapabilities(adapter.capabilities)

  describe(`${adapter.name} shared integration scenarios`, () => {
    registerLifecycleIntegration(adapter)
    registerCrudIntegration(adapter)
    registerUpsertIntegration(adapter)
    registerTransactionIntegration(adapter)
    registerDriverErrorIntegration(adapter)
    registerQueryDriverErrorIntegration(adapter)

    registerDialectIntegrationScenario(
      adapter,
      ['migration', 'query'],
      'executes a portable Migration Plan',
      async () => {
        await adapter.withDatabase([ContractRecords], async ({ db }) => {
          const plan = await db.migrate().plan()
          expect(plan.steps.map((step) => step.kind)).toEqual([
            'create_table',
            'create_index',
          ])

          expect(plan.steps.every((step) => !('sql' in step))).toBe(true)
          await expect(db.migrate().execute()).resolves.toBeUndefined()
          await db.insert(ContractRecords).values({ label: 'migrated' }).execute()

          await expect(db.from(ContractRecords).execute()).resolves.toMatchObject([
            { label: 'migrated' },
          ])
        })
      },
    )

    registerDialectIntegrationScenario(
      adapter,
      ['convergence', 'migration'],
      'converges to an empty second plan',
      async () => {
        await adapter.withDatabase([ContractRecords], async ({ db }) => {
          const initial = await db.migrate().plan()
          expect(initial.steps.length).toBeGreaterThan(0)
          await db.migrate().execute()
          await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
        })
      },
    )
  })
}

/**
 * Registers the scenario that commits and rolls back root transactions.
 *
 * @param adapter - Adapter supplying the dialect behavior exercised by shared contract
 *   scenarios.
 */
function registerTransactionIntegration(adapter: DialectIntegrationAdapter) {
  registerDialectIntegrationScenario(
    adapter,
    ['transaction', 'migration', 'query'],
    'commits and rolls back root transactions',
    async () => {
      await adapter.withDatabase([ContractRecords], async ({ db }) => {
        await db.migrate().execute()

        await db.transaction(async (trx) => {
          await trx.insert(ContractRecords).values({ label: 'committed' }).execute()
        })

        await expect(
          db.transaction(async (trx) => {
            await trx.insert(ContractRecords).values({ label: 'rolled back' }).execute()
            throw new Error('rollback requested')
          }),
        ).rejects.toThrow('rollback requested')

        await expect(db.from(ContractRecords).execute()).resolves.toMatchObject([
          { label: 'committed' },
        ])
      })
    },
  )
}

/** Verifies database failures through the same public client path for both dialects. */
function registerDriverErrorIntegration(adapter: DialectIntegrationAdapter): void {
  registerDialectIntegrationScenario(
    adapter,
    ['migration', 'query', 'transaction'],
    'reports native constraint failures with dialect, code, SQL, and cause',
    async () => {
      await adapter.withDatabase([ContractRecords], async ({ db }) => {
        await db.migrate().execute()
        const secret = 'secret-bound-value'
        await db.insert(ContractRecords).values({ label: secret }).execute()

        const write = await db
          .insert(ContractRecords)
          .values({ label: secret })
          .execute()
          .catch((cause: unknown) => cause)

        expect(write).toBeInstanceOf(DriverError)

        expect(write).toMatchObject({
          _tag: 'DriverError',
          dialect: adapter.dialectId,
        })

        expect(typeof (write as DriverError).code).toBe('string')
        expect((write as DriverError).cause).toBeInstanceOf(Error)
        expect((write as DriverError).sql).not.toContain(secret)
        expect(write).not.toHaveProperty('params')

        const transaction = await db
          .transaction(async (trx) => {
            await trx.insert(ContractRecords).values({ label: secret }).execute()
          })
          .catch((cause: unknown) => cause)

        expect(transaction).toMatchObject({
          _tag: 'DriverError',
          dialect: adapter.dialectId,
          code: (write as DriverError).code,
        })

        expect((transaction as DriverError).sql).not.toContain(secret)
      })
    },
  )
}

/** Verifies a row query failure before the relation exists in the database. */
function registerQueryDriverErrorIntegration(adapter: DialectIntegrationAdapter): void {
  registerDialectIntegrationScenario(
    adapter,
    ['query'],
    'reports missing-relation queries as parameter-free driver errors',
    async () => {
      await adapter.withDatabase([ContractRecords], async ({ db }) => {
        const secret = 'secret-bound-value'
        const error = await db
          .from(ContractRecords)
          .where(ContractRecords.label, 'eq', secret)
          .execute()
          .catch((cause: unknown) => cause)

        expect(error).toBeInstanceOf(DriverError)
        expect(error).toMatchObject({ _tag: 'DriverError', dialect: adapter.dialectId })
        expect(typeof (error as DriverError).code).toBe('string')
        expect((error as DriverError).sql).not.toContain(secret)
        expect((error as DriverError).cause).toBeInstanceOf(Error)
        expect(error).not.toHaveProperty('params')
      })
    },
  )
}

function registerCrudIntegration(adapter: DialectIntegrationAdapter) {
  registerDialectIntegrationScenario(
    adapter,
    ['query', 'migration'],
    'round-trips representative CRUD',
    async () => {
      await adapter.withDatabase([ContractRecords], async ({ db }) => {
        await db.migrate().execute()
        const inserted = await db
          .insert(ContractRecords)
          .values({ label: 'shared query' })
          .executeTakeFirstOrThrow()

        expect(inserted).toMatchObject({ label: 'shared query', active: true })

        await expect(
          db.from(ContractRecords).where(ContractRecords.id, 'eq', inserted.id).execute(),
        ).resolves.toEqual([inserted])

        await expect(
          db
            .update(ContractRecords)
            .set({ active: false })
            .where(ContractRecords.id, 'eq', inserted.id)
            .execute(),
        ).resolves.toMatchObject([{ active: false }])

        await expect(
          db.from(ContractRecords).where(ContractRecords.id, 'eq', inserted.id).execute(),
        ).resolves.toMatchObject([{ active: false }])

        await expect(
          db
            .delete(ContractRecords)
            .where(ContractRecords.id, 'eq', inserted.id)
            .execute(),
        ).resolves.toHaveLength(1)

        await expect(
          db.from(ContractRecords).where(ContractRecords.id, 'eq', inserted.id).execute(),
        ).resolves.toEqual([])
      })
    },
  )
}

/** Registers shared insert conflict behavior for PostgreSQL and SQLite. */
function registerUpsertIntegration(adapter: DialectIntegrationAdapter) {
  registerDialectIntegrationScenario(
    adapter,
    ['query', 'migration'],
    'round-trips insert conflict actions, composite targets, bulk rows, and returning',
    async () => {
      await adapter.withDatabase(
        [ContractRecords, ContractScopedRecords],
        async ({ db }) => {
          const scoped = ContractScopedRecords

          await db.migrate().execute()
          await db.insert(ContractRecords).values({ label: 'stable' }).execute()

          const conflict = db
            .insert(ContractRecords)
            .values({ label: 'stable', active: false })
            .onConflict([ContractRecords.label])

          expect(await conflict.doNothing().execute()).toEqual([])

          const updated = await conflict
            .doUpdate({ active: excluded(ContractRecords.active) })
            .returning([ContractRecords.label, ContractRecords.active])
            .executeTakeFirstOrThrow()

          expect(updated).toEqual({ label: 'stable', active: false })

          await db
            .insert(scoped)
            .values({ scope: 'a', key: 'one', value: 'original' })
            .execute()

          await db
            .insert(scoped)
            .values([
              { scope: 'a', key: 'one', value: 'updated' },
              { scope: 'a', key: 'two', value: 'second' },
            ])
            .onConflict([scoped.scope, scoped.key])
            .doUpdate({ value: excluded(scoped.value) })
            .execute()

          expect(
            await db
              .from(scoped)
              .select([scoped.scope, scoped.key, scoped.value])
              .orderBy(scoped.key)
              .execute(),
          ).toEqual([
            { scope: 'a', key: 'one', value: 'updated' },
            { scope: 'a', key: 'two', value: 'second' },
          ])
        },
      )
    },
  )
}

/**
 * Registers the scenario that connects and closes idempotently.
 *
 * @param adapter - Adapter supplying the dialect behavior exercised by shared contract
 *   scenarios.
 */
function registerLifecycleIntegration(adapter: DialectIntegrationAdapter) {
  beforeAll(() => adapter.readiness())

  registerDialectIntegrationScenario(
    adapter,
    ['lifecycle'],
    'connects and closes idempotently',
    async () => {
      await adapter.withDatabase([ContractRecords], async ({ db }) => {
        await expect(db.ping()).resolves.toBeUndefined()
        await db.close()
        await expect(db.close()).resolves.toBeUndefined()
      })
    },
  )
}
