import {
  boolean,
  date,
  integer,
  isoDate,
  isoDateTime,
  isoDateTimeSecond,
  isoTime,
  isoTimeSecond,
  isoTimestamp,
  nullable,
  number,
  pipe,
  safeParse,
  string,
  toDate,
} from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Db, InferSelect, TableHandle } from '@/index'
import { DriverError, column, defineTable, excluded, reference } from '@/index'

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
    callback: (
      context: Readonly<{ db: Db<TSchemas>; nativeSql(sql: string): Promise<void> }>,
    ) => Promise<TResult>,
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

const ContractParents = defineTable(
  'contract_parents',
  {
    id: pipe(number(), integer()),
  },
  { primaryKey: 'id' },
)

const ContractFailures = defineTable(
  'contract_failures',
  {
    id: pipe(number(), integer()),
    value: nullable(string()),
    owner: pipe(number(), integer()),
  },
  { primaryKey: 'id', indexes: [{ columns: ['value'], unique: true }] },
)

const ContractTemporal = defineTable(
  'contract_temporal',
  {
    id: pipe(string(), isoDate()),
    minuteTime: pipe(string(), isoTime()),
    secondTime: pipe(string(), isoTimeSecond()),
    minuteLocal: pipe(string(), isoDateTime()),
    secondLocal: pipe(string(), isoDateTimeSecond()),
    instant: pipe(string(), isoTimestamp()),
    nullableInstant: nullable(
      pipe(
        string(),
        isoTimestamp(),
        column({
          physicalType: { postgresql: 'timestamp with time zone', sqlite: 'VARCHAR(40)' },
        }),
      ),
    ),
    asDate: date(),
    convertedDate: pipe(string(), isoTimestamp(), toDate()),
  },
  { primaryKey: 'id' },
)

const ContractTemporalReference = defineTable(
  'contract_temporal_reference',
  { id: string(), temporalId: nullable(reference(ContractTemporal, 'id')) },
  { primaryKey: 'id' },
)

const CONTRACT_TEMPORAL_TABLES = [ContractTemporal, ContractTemporalReference] as const
type TemporalDb = Db<typeof CONTRACT_TEMPORAL_TABLES>

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
    registerTemporalIntegration(adapter)
    registerWriteCountIntegration(adapter)
    registerUpsertIntegration(adapter)
    registerTransactionIntegration(adapter)
    registerDriverErrorIntegration(adapter)
    registerConstraintDriverErrorIntegration(adapter)
    registerQueryDriverErrorIntegration(adapter)

    registerDialectIntegrationScenario(
      adapter,
      ['migration', 'query'],
      'should execute a portable Migration Plan',
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
      'should converge to an empty second plan',
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
    'should commit and roll back root transactions',
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

/** Verifies portable wrapper context and recursive native diagnostics. */
function assertContextualDriverFailure(
  failure: unknown,
  adapter: DialectIntegrationAdapter,
  secret: string,
): void {
  expect(failure).toBeInstanceOf(DriverError)

  expect(failure).toMatchObject({
    _tag: 'DriverError',
    dialect: adapter.dialectId,
    kind: 'uniqueViolation',
    retryable: false,
  })

  const error = failure as DriverError
  expect(typeof error.code).toBe('string')
  expect(error.cause).toBeInstanceOf(Error)
  expect(error.sql).not.toContain(secret)
  expect(failure).not.toHaveProperty('params')
  expect(error.message).toContain('insert into')
  expect(error.message).toContain('contract_records')
  expect(error.message).not.toContain(secret)

  expect(JSON.parse(JSON.stringify(error))).toMatchObject({
    _tag: 'DriverError',
    message: expect.stringContaining('insert into') as string,
    cause: { message: expect.any(String) as string, code: error.code },
  })
}

/** Verifies database failures through the same public client path for both dialects. */
function registerDriverErrorIntegration(adapter: DialectIntegrationAdapter): void {
  registerDialectIntegrationScenario(
    adapter,
    ['migration', 'query', 'transaction'],
    'should report native constraint failures with dialect, code, SQL, and cause',
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

        assertContextualDriverFailure(write, adapter, secret)

        const transaction = await db
          .transaction(async (trx) => {
            await trx.insert(ContractRecords).values({ label: secret }).execute()
          })
          .catch((cause: unknown) => cause)

        expect(transaction).toMatchObject({
          _tag: 'DriverError',
          dialect: adapter.dialectId,
          code: (write as DriverError).code,
          kind: 'uniqueViolation',
          retryable: false,
        })

        expect((transaction as DriverError).sql).not.toContain(secret)
      })
    },
  )
}

/** Exercises native constraints through the same public write paths on each member. */
function registerConstraintDriverErrorIntegration(
  adapter: DialectIntegrationAdapter,
): void {
  registerDialectIntegrationScenario(
    adapter,
    ['query'],
    'should classify real constraint failures across write operations',
    async () => {
      await adapter.withDatabase(
        [ContractParents, ContractFailures],
        async ({ db, nativeSql }) =>
          assertConstraintFailures(db, nativeSql, adapter.dialectId),
      )
    },
  )
}

type ConstraintDb = Db<readonly [typeof ContractParents, typeof ContractFailures]>

type ConstraintCase = Readonly<{
  scenario: string
  kind: DriverError['kind']
  operation: 'insert into' | 'upsert into' | 'update' | 'delete from'
  relation: 'contract_failures' | 'contract_parents'
  execute(): Promise<unknown>
}>

/** Creates stricter physical constraints than the authored columns can express. */
async function prepareConstraintFixture(
  db: ConstraintDb,
  nativeSql: (sql: string) => Promise<void>,
): Promise<void> {
  await nativeSql(`
    create table contract_parents (id integer primary key);
    create table contract_failures (
      id integer primary key,
      value text not null check (length(value) > 1),
      owner integer not null references contract_parents(id),
      unique(value)
    );
  `)

  await db.insert(ContractParents).values({ id: 1 }).execute()

  await db
    .insert(ContractFailures)
    .values([
      { id: 1, value: 'first', owner: 1 },
      { id: 2, value: 'second', owner: 1 },
    ])
    .execute()
}

/** Exercises each portable constraint kind using native insert failures. */
function insertConstraintCases(db: ConstraintDb): readonly ConstraintCase[] {
  return [
    {
      scenario: 'insert unique',
      kind: 'uniqueViolation',
      operation: 'insert into',
      relation: 'contract_failures',
      execute: () =>
        db
          .insert(ContractFailures)
          .values({ id: 3, value: 'second', owner: 1 })
          .execute(),
    },
    {
      scenario: 'insert foreign key',
      kind: 'foreignKeyViolation',
      operation: 'insert into',
      relation: 'contract_failures',
      execute: () =>
        db
          .insert(ContractFailures)
          .values({ id: 3, value: 'third', owner: 999 })
          .execute(),
    },
    {
      scenario: 'insert not null',
      kind: 'notNullViolation',
      operation: 'insert into',
      relation: 'contract_failures',
      execute: () =>
        db.insert(ContractFailures).values({ id: 3, value: null, owner: 1 }).execute(),
    },
    {
      scenario: 'insert check',
      kind: 'checkViolation',
      operation: 'insert into',
      relation: 'contract_failures',
      execute: () =>
        db.insert(ContractFailures).values({ id: 3, value: 'x', owner: 1 }).execute(),
    },
  ]
}

/** Exercises the common failure boundary after update, delete, and upsert execution. */
function mutationConstraintCases(db: ConstraintDb): readonly ConstraintCase[] {
  return [
    {
      scenario: 'update unique',
      kind: 'uniqueViolation',
      operation: 'update',
      relation: 'contract_failures',
      execute: () =>
        db
          .update(ContractFailures)
          .set({ value: 'second' })
          .where(ContractFailures.id, 'eq', 1)
          .execute(),
    },
    {
      scenario: 'delete foreign key',
      kind: 'foreignKeyViolation',
      operation: 'delete from',
      relation: 'contract_parents',
      execute: () =>
        db.delete(ContractParents).where(ContractParents.id, 'eq', 1).execute(),
    },
    {
      scenario: 'upsert unique',
      kind: 'uniqueViolation',
      operation: 'upsert into',
      relation: 'contract_failures',
      execute: () =>
        db
          .insert(ContractFailures)
          .values({ id: 1, value: 'second', owner: 1 })
          .onConflict([ContractFailures.id])
          .doUpdate({ value: excluded(ContractFailures.value) })
          .execute(),
    },
  ]
}

/** Verifies identical logical classifications from both real database engines. */
async function assertConstraintFailures(
  db: ConstraintDb,
  nativeSql: (sql: string) => Promise<void>,
  dialectId: string,
): Promise<void> {
  await prepareConstraintFixture(db, nativeSql)

  for (const { scenario, kind, operation, relation, execute } of [
    ...insertConstraintCases(db),
    ...mutationConstraintCases(db),
  ]) {
    const failure = await execute().catch((cause: unknown) => cause)
    expect(failure, scenario).toBeInstanceOf(DriverError)

    expect(failure, scenario).toMatchObject({
      dialect: dialectId,
      kind,
      retryable: false,
    })

    expect((failure as DriverError).cause, scenario).toBeInstanceOf(Error)
    expect((failure as DriverError).message, scenario).toContain(operation)
    expect((failure as DriverError).message, scenario).toContain(relation)
    expect(JSON.stringify(failure), scenario).toContain('"_tag":"DriverError"')
  }
}

/** Verifies a row query failure before the relation exists in the database. */
function registerQueryDriverErrorIntegration(adapter: DialectIntegrationAdapter): void {
  registerDialectIntegrationScenario(
    adapter,
    ['query'],
    'should report missing-relation queries as parameter-free driver errors',
    async () => {
      await adapter.withDatabase([ContractRecords], async ({ db }) => {
        const secret = 'secret-bound-value'
        const error = await db
          .from(ContractRecords)
          .where(ContractRecords.label, 'eq', secret)
          .execute()
          .catch((cause: unknown) => cause)

        expect(error).toBeInstanceOf(DriverError)

        expect(error).toMatchObject({
          _tag: 'DriverError',
          dialect: adapter.dialectId,
          kind: 'unknown',
          retryable: false,
        })

        expect(typeof (error as DriverError).code).toBe('string')
        expect((error as DriverError).sql).not.toContain(secret)
        expect((error as DriverError).cause).toBeInstanceOf(Error)
        expect(error).not.toHaveProperty('params')
        expect((error as DriverError).message).toContain('select from')
        expect((error as DriverError).message).toContain('contract_records')
        expect((error as DriverError).message).not.toContain(secret)

        expect(JSON.parse(JSON.stringify(error))).toMatchObject({
          cause: {
            message: expect.any(String) as string,
            code: (error as DriverError).code,
          },
        })
      })
    },
  )
}

function registerCrudIntegration(adapter: DialectIntegrationAdapter) {
  registerDialectIntegrationScenario(
    adapter,
    ['query', 'migration'],
    'should round-trip representative CRUD',
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

/** Verifies the same native DML counts through every public client scope. */
function registerWriteCountIntegration(adapter: DialectIntegrationAdapter) {
  for (const scope of ['root', 'transaction', 'nested transaction'] as const) {
    registerDialectIntegrationScenario(
      adapter,
      scope === 'root' ? ['query', 'migration'] : ['query', 'migration', 'transaction'],
      `should return affected-row counts in a ${scope} scope`,
      async () => {
        await adapter.withDatabase([ContractRecords], async ({ db }) => {
          await db.migrate().execute()

          if (scope === 'root') await assertWriteCounts(db)
          else if (scope === 'transaction') await db.transaction(assertWriteCounts)
          else await db.transaction((trx) => trx.transaction(assertWriteCounts))
        })
      },
    )
  }
}

/** Exercises independently known single, batch, no-match, and conflict counts. */
async function assertWriteCounts(
  db: Db<readonly [typeof ContractRecords]>,
): Promise<void> {
  const records = ContractRecords
  await expect(
    db.insert(records).values({ label: 'one' }).returningNone().execute(),
  ).resolves.toEqual({ rowCount: 1 })

  await expect(
    db
      .insert(records)
      .values([{ label: 'two' }, { label: 'three' }])
      .returningNone()
      .execute(),
  ).resolves.toEqual({ rowCount: 2 })

  await expect(
    db
      .update(records)
      .set({ active: false })
      .where({ label: 'absent' })
      .returningNone()
      .execute(),
  ).resolves.toEqual({ rowCount: 0 })

  await expect(
    db.update(records).set({ active: false }).all().returningNone().execute(),
  ).resolves.toEqual({ rowCount: 3 })

  await assertUpsertCounts(db)

  await expect(
    db.delete(records).where({ label: 'absent' }).returningNone().execute(),
  ).resolves.toEqual({ rowCount: 0 })

  await expect(db.delete(records).all().returningNone().execute()).resolves.toEqual({
    rowCount: 4,
  })

  await expect(db.from(records).execute()).resolves.toEqual([])
}

/** Verifies inserted, updated, and skipped conflict outcomes on an existing fixture. */
async function assertUpsertCounts(
  db: Db<readonly [typeof ContractRecords]>,
): Promise<void> {
  const records = ContractRecords
  await expect(
    db.update(records).set({ active: false }).all().returningNone().execute(),
  ).resolves.toEqual({ rowCount: 3 })

  await expect(
    db
      .insert(records)
      .values({ label: 'four' })
      .returningNone()
      .onConflict([records.label])
      .doUpdate({ active: true })
      .execute(),
  ).resolves.toEqual({ rowCount: 1 })

  await expect(
    db
      .insert(records)
      .values({ label: 'four' })
      .onConflict([records.label])
      .doUpdate({ active: false })
      .returningNone()
      .execute(),
  ).resolves.toEqual({ rowCount: 1 })

  await expect(
    db
      .insert(records)
      .values({ label: 'four' })
      .onConflict([records.label])
      .doNothing()
      .returningNone()
      .execute(),
  ).resolves.toEqual({ rowCount: 0 })
}

/** Registers shared insert conflict behavior for PostgreSQL and SQLite. */
function registerUpsertIntegration(adapter: DialectIntegrationAdapter) {
  registerDialectIntegrationScenario(
    adapter,
    ['query', 'migration'],
    'should round-trip insert conflict actions, composite targets, bulk rows, and returning',
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
    'should connect and close idempotently',
    async () => {
      await adapter.withDatabase([ContractRecords], async ({ db }) => {
        await expect(db.ping()).resolves.toBeUndefined()
        await db.close()
        await expect(db.close()).resolves.toBeUndefined()
      })
    },
  )
}

/** Checks both returning and selected values after temporal insertion. */
async function assertTemporalInsert(db: TemporalDb): Promise<void> {
  const input = {
    id: '0042-01-02',
    minuteTime: '03:04',
    secondTime: '03:04:05',
    minuteLocal: '2026-01-02T03:04',
    secondLocal: '2026-01-02T03:04:05',
    instant: '2026-01-02T03:04:05.123456Z',
    nullableInstant: null,
    asDate: new Date('2026-01-02T03:04:05.123Z'),
    convertedDate: '2026-01-02T03:04:05.123Z',
  }

  const inserted = await db
    .insert(ContractTemporal)
    .values(input)
    .executeTakeFirstOrThrow()

  expect(inserted).toMatchObject({
    id: input.id,
    minuteTime: input.minuteTime,
    secondTime: input.secondTime,
    minuteLocal: input.minuteLocal,
    secondLocal: input.secondLocal,
    nullableInstant: null,
    asDate: input.asDate,
    convertedDate: new Date(input.convertedDate),
  })

  expect(safeParse(pipe(string(), isoTimestamp()), inserted.instant).success).toBe(true)
  expect(new Date(inserted.instant).getTime()).toBe(new Date(input.instant).getTime())
  expect(inserted.instant).toMatch(/\.123456(?:Z|[+-]\d{2}:\d{2})$/)

  const selected = await db
    .from(ContractTemporal)
    .where({ id: input.id })
    .executeTakeFirstOrThrow()

  expect(selected).toEqual(inserted)
}

/** Checks the updated logical values without requiring a particular session offset. */
function assertTemporalUpdateResult(updated: InferSelect<typeof ContractTemporal>): void {
  expect(updated).toMatchObject({
    id: '0042-01-03',
    minuteTime: '04:05',
    secondTime: '04:05:06',
    minuteLocal: '2026-01-03T04:05',
    secondLocal: '2026-01-03T04:05:06',
    asDate: new Date('2026-01-03T04:05:06.789Z'),
    convertedDate: new Date('2026-01-03T04:05:06.789Z'),
  })

  expect(safeParse(pipe(string(), isoTimestamp()), updated.instant).success).toBe(true)

  expect(new Date(updated.instant).getTime()).toBe(
    new Date('2026-01-02T03:04:06.654321+05:30').getTime(),
  )

  expect(updated.instant).toMatch(/\.654321(?:Z|[+-]\d{2}:\d{2})$/)

  expect(safeParse(pipe(string(), isoTimestamp()), updated.nullableInstant).success).toBe(
    true,
  )

  expect(new Date(updated.nullableInstant!).getTime()).toBe(
    new Date('2026-01-03T04:05:06Z').getTime(),
  )
}

/** Checks update returning against a later selected row. */
async function assertTemporalUpdate(db: TemporalDb): Promise<string> {
  const updated = await db
    .update(ContractTemporal)
    .set({
      id: '0042-01-03',
      minuteTime: '04:05',
      secondTime: '04:05:06',
      minuteLocal: '2026-01-03T04:05',
      secondLocal: '2026-01-03T04:05:06',
      instant: '2026-01-02T03:04:06.654321+05:30',
      nullableInstant: '2026-01-03T04:05:06Z',
      asDate: new Date('2026-01-03T04:05:06.789Z'),
      convertedDate: '2026-01-03T04:05:06.789Z',
    })
    .where({ id: '0042-01-02' })
    .executeTakeFirstOrThrow()

  assertTemporalUpdateResult(updated)

  const selected = await db
    .from(ContractTemporal)
    .where({ id: updated.id })
    .executeTakeFirstOrThrow()

  expect(selected).toEqual(updated)
  return updated.id
}

/** Checks that temporal primary keys retain their string reference representation. */
async function assertTemporalReference(
  db: TemporalDb,
  temporalId: string,
): Promise<void> {
  const referenceRow = { id: 'child', temporalId }

  expect(
    await db.insert(ContractTemporalReference).values(referenceRow).execute(),
  ).toEqual([referenceRow])

  expect(
    await db.from(ContractTemporalReference).where({ id: 'child' }).execute(),
  ).toEqual([referenceRow])
}

/** Exercises the shared temporal result contract on both native engines. */
function registerTemporalIntegration(adapter: DialectIntegrationAdapter): void {
  registerDialectIntegrationScenario(
    adapter,
    ['query', 'migration', 'convergence'],
    'should round-trip ISO strings and Dates through temporal storage',
    async () => {
      await adapter.withDatabase(CONTRACT_TEMPORAL_TABLES, async ({ db }) => {
        await db.migrate().execute()
        await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

        await assertTemporalInsert(db)
        const updatedId = await assertTemporalUpdate(db)
        await assertTemporalReference(db, updatedId)
      })
    },
  )
}
