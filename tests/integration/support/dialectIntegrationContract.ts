import { boolean, integer, number, pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Db, TableHandle } from '@/index'
import { column, defineTable } from '@/index'

type IntegrationCapabilityName =
  | 'lifecycle'
  | 'query'
  | 'transaction'
  | 'migration'
  | 'convergence'

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

function assertNever(value: never): never {
  throw new Error(`Unexpected integration capability: ${JSON.stringify(value)}`)
}

function scenario(
  adapter: DialectIntegrationAdapter,
  capabilities: readonly IntegrationCapabilityName[],
  title: string,
  test: () => Promise<void>,
): void {
  const unsupported = capabilities.flatMap((capability) => {
    const support = adapter.capabilities[capability]

    switch (support.state) {
      case 'supported':
        return []
      case 'unsupported':
        return [`${capability}: ${support.reason}`]
    }

    return assertNever(support)
  })

  if (unsupported.length > 0) {
    it.skip(`${title} (${unsupported.join('; ')})`, test)
    return
  }

  it(title, test)
}

/** Registers public, reusable integration behavior for one complete Dialect member. */
export function registerDialectIntegrationScenarios(
  adapter: DialectIntegrationAdapter,
): void {
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
