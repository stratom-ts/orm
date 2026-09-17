import { boolean, integer, number, pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Db, TableHandle } from '@/index'
import { column, defineTable } from '@/index'

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

export interface DialectIntegrationAdapter {
  readonly name: string
  readonly capabilities: Readonly<
    Record<IntegrationCapabilityName, IntegrationCapability>
  >
  readiness(): Promise<void>
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
    const capability = capabilities[name]
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

/** Returns whether every capability required for an integration scenario is supported. */
export function shouldRegisterDialectIntegrationScenario(
  capabilities: DialectIntegrationAdapter['capabilities'],
  required: readonly IntegrationCapabilityName[],
): boolean {
  return !required.some((capability) => capabilities[capability].state === 'unsupported')
}

function scenario(
  adapter: DialectIntegrationAdapter,
  capabilities: readonly IntegrationCapabilityName[],
  title: string,
  test: () => Promise<void>,
): void {
  // Unsupported capabilities do not register a scenario. This keeps the suite
  // free of skipped tests while the adapter capability declaration remains the
  // source of truth for the omitted behavior.
  if (!shouldRegisterDialectIntegrationScenario(adapter.capabilities, capabilities))
    return

  it(title, test)
}

/** Registers public, reusable integration behavior for one complete Dialect member. */
export function registerDialectIntegrationScenarios(
  adapter: DialectIntegrationAdapter,
): void {
  validateDialectIntegrationCapabilities(adapter.capabilities)
  describe(`${adapter.name} shared integration scenarios`, () => {
    beforeAll(() => adapter.readiness())

    scenario(adapter, ['lifecycle'], 'connects and closes idempotently', async () => {
      await adapter.withDatabase([ContractRecords], async ({ db }) => {
        await expect(db.ping()).resolves.toBeUndefined()
        await db.close()
        await expect(db.close()).resolves.toBeUndefined()
      })
    })

    scenario(
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
            db
              .from(ContractRecords)
              .where(ContractRecords.id, 'eq', inserted.id)
              .execute(),
          ).resolves.toEqual([inserted])
          await expect(
            db
              .update(ContractRecords)
              .set({ active: false })
              .where(ContractRecords.id, 'eq', inserted.id)
              .execute(),
          ).resolves.toMatchObject([{ active: false }])
          await expect(
            db
              .from(ContractRecords)
              .where(ContractRecords.id, 'eq', inserted.id)
              .execute(),
          ).resolves.toMatchObject([{ active: false }])
          await expect(
            db
              .delete(ContractRecords)
              .where(ContractRecords.id, 'eq', inserted.id)
              .execute(),
          ).resolves.toHaveLength(1)
          await expect(
            db
              .from(ContractRecords)
              .where(ContractRecords.id, 'eq', inserted.id)
              .execute(),
          ).resolves.toEqual([])
        })
      },
    )

    scenario(
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

    scenario(
      adapter,
      ['migration', 'query'],
      'executes a portable Migration Plan',
      async () => {
        await adapter.withDatabase([ContractRecords], async ({ db }) => {
          const plan = await db.migrate().dryRun()
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

    scenario(
      adapter,
      ['convergence', 'migration'],
      'converges to an empty second plan',
      async () => {
        await adapter.withDatabase([ContractRecords], async ({ db }) => {
          const initial = await db.migrate().dryRun()
          expect(initial.steps.length).toBeGreaterThan(0)
          await db.migrate().execute()
          await expect(db.migrate().dryRun()).resolves.toEqual({ steps: [] })
        })
      },
    )
  })
}
