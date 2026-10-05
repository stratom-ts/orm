import { describe, expect, it, vi } from 'vitest'

import type { MigrationDryRunAction } from '@/ddl/migrate'
import { createMigrateBuilder } from '@/ddl/migrate'
import type {
  DialectMigrationAdapter,
  MigrationProgram,
  MigrationRuntimeOptions,
} from '@/ddl/migrationProgram'
import { postgresDialect } from '@/dialects/postgres'
import type { Executor } from '@/query'

import { completePostgresCatalog } from '../helpers/catalog'

const returnsGroupedPhysicalActionsWithStableRedactionAndNoExecutionData2: MigrationProgram['preconditions'] =
  [
    {
      kind: 'column_has_no_nulls',
      relation: {
        namespace: [
          {
            role: 'database',
            identifier: { spelling: 'test', comparisonKey: 'test' },
          },
          {
            role: 'schema',
            identifier: { spelling: 'public', comparisonKey: 'public' },
          },
        ],
        relation: { spelling: 'users', comparisonKey: 'users' },
      },
      column: 'email',
      sourceStepIndexes: [3],
    },
  ]

const returnsGroupedPhysicalActionsWithStableRedactionAndNoExecutionData = {
  atomicity: 'statement-atomic',
  preconditions: [
    {
      kind: 'column_has_no_nulls',
      relation: {
        namespace: [
          {
            role: 'database',
            identifier: { spelling: 'test', comparisonKey: 'test' },
          },
          {
            role: 'schema',
            identifier: { spelling: 'public', comparisonKey: 'public' },
          },
        ],
        relation: { spelling: 'users', comparisonKey: 'users' },
      },
      column: 'email',
      sourceStepIndexes: [3],
    },
  ],
  actions: [
    {
      sourceStepIndexes: [1, 3],
      transaction: 'allowed',
      statements: [
        {
          sql: 'alter table x add column a text',
          params: ['[REDACTED]', '[REDACTED]'],
        },
        { sql: 'alter table x add column b text', params: [] },
      ],
    },
    {
      sourceStepIndexes: [4],
      transaction: 'forbidden',
      statements: [{ sql: 'create index users_email_idx on users (email)', params: [] }],
    },
  ],
}

const namespaceContext = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

const executor: Executor = {
  /** Executes fixture SQL with the configured native observations. */
  async execute() {
    return []
  },
  /** Runs a fixture statement with configured outcomes. */
  async run() {
    return undefined
  },
}

/**
 * Creates the operation runner fixture used by the contract scenario.
 *
 * @returns The operation runner fixture used by the contract scenario.
 */
function createOperationRunner() {
  const state = { calls: 0 }

  /**
   * Runs the callback with the fixture executor and records the operation boundary.
   *
   * @param operation - Work to run within the current session or error boundary.
   *
   * @returns The callback value after the operation and required cleanup complete.
   */
  async function runOperation<T>(
    operation: (
      executor: Executor,
      databaseIdentity: string,
      discard: () => void,
      cancel: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    state.calls += 1
    return operation(
      executor,
      'test',
      vi.fn<() => void>(),
      vi.fn<() => Promise<void>>(async () => undefined),
    )
  }

  return { runOperation, state }
}

/**
 * Creates the migration member fixture used by the contract scenario.
 *
 * @param identityAdapter - Selected adapter's canonical identity operations.
 *
 * @returns The migration member fixture used by the contract scenario.
 */
function createMigrationMember(identityAdapter = 'postgresql') {
  const selected = postgresDialect.migration
  const createIdentity = vi.fn<typeof selected.planning.identity.create>(
    selected.planning.identity.create,
  )

  const introspectCatalog = vi.fn<typeof selected.catalog.introspectCatalog>(
    async (_executor, request: Parameters<typeof completePostgresCatalog>[1]) =>
      completePostgresCatalog(
        {
          namespaceContext,
          tables: [],
          nameReservations: [],
          constraintNameReservations: [],
        },
        request,
      ),
  )

  const lower = vi.fn<typeof selected.lower>(selected.lower)
  const execute = vi.fn<typeof selected.execute>(
    async (options: MigrationRuntimeOptions) => {
      const program = await options.prepare()
      return {
        outcome:
          program.actions.length === 0 ? ('unchanged' as const) : ('applied' as const),
      }
    },
  )

  const migration: DialectMigrationAdapter = {
    planning: {
      ...selected.planning,
      identity: {
        ...selected.planning.identity,
        id: identityAdapter,
        create: createIdentity,
      },
    },
    catalog: { introspectCatalog },
    lower,
    execute,
  }

  return { migration, createIdentity, introspectCatalog, lower, execute }
}

describe('dialect-neutral migration adapter contract', () => {
  it('uses one supplied migration member for plan and execute planning', async () => {
    const member = createMigrationMember()
    const operationRunner = createOperationRunner()
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: operationRunner.runOperation,
    })

    await expect(builder.plan()).resolves.toEqual({ steps: [] })
    await expect(builder.execute()).resolves.toBeUndefined()

    expect(operationRunner.state.calls).toBe(2)
    expect(member.introspectCatalog).toHaveBeenCalledTimes(2)
    expect(member.createIdentity).toHaveBeenCalledTimes(2)
    expect(member.execute).toHaveBeenCalledTimes(1)
    expect(member.execute.mock.calls[0]![0].lockTimeoutMs).toBeUndefined()
    expect(member.lower).toHaveBeenCalledTimes(1)

    expect(member.lower).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ identityAdapter: 'postgresql' }) as unknown,
      }),
      expect.objectContaining({ identityAdapter: 'postgresql' }),
    )
  })
})

describe('dialect-neutral migration adapter contract: keeps executing Semantic Profile validation explicit at lowering', () => {
  it('keeps executing Semantic Profile validation explicit at lowering', async () => {
    const member = createMigrationMember('not-postgresql')
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    const error = await builder.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
    })

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/does not match PostgreSQL/)

    expect(member.lower).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          identityAdapter: 'not-postgresql',
        }) as unknown,
      }),
      expect.objectContaining({ identityAdapter: 'not-postgresql' }),
    )
  })
})

describe('dialect-neutral migration adapter contract: validates the Semantic Profile during dry run', () => {
  it('validates the Semantic Profile during dry run', async () => {
    const member = createMigrationMember('not-postgresql')
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    const error = await builder.dryRun().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
      message: "Executing profile adapter 'not-postgresql' does not match PostgreSQL",
    })

    expect(member.lower).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          identityAdapter: 'not-postgresql',
        }) as unknown,
      }),
      expect.objectContaining({ identityAdapter: 'not-postgresql' }),
    )

    expect(member.execute).not.toHaveBeenCalled()
  })
})

describe('dialect-neutral migration program preview and issues', () => {
  it('returns grouped physical actions with stable redaction and no execution', async () => {
    const member = createMigrationMember()
    const sourceStepIndexes = [1, 3]
    member.lower.mockReturnValue({
      program: {
        atomicity: 'statement-atomic',
        preconditions: structuredClone(
          returnsGroupedPhysicalActionsWithStableRedactionAndNoExecutionData2,
        ),
        actions: [
          {
            sourceStepIndexes,
            transaction: 'allowed',
            statements: [
              {
                sql: 'alter table x add column a text',
                params: ['secret', 42],
                assertSession: vi.fn<() => void>(),
              },
              { sql: 'alter table x add column b text', params: [] },
            ],
          },
          {
            sourceStepIndexes: [4],
            transaction: 'forbidden',
            statements: [
              { sql: 'create index users_email_idx on users (email)', params: [] },
            ],
          },
        ],
      },
    })

    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    const preview = await builder.dryRun()

    assertMigrationPreview(preview, member)

    sourceStepIndexes.push(99)
    expect(preview.actions[0]!.sourceStepIndexes).toEqual([1, 3])
  })
})

describe('dialect-neutral migration program preview and issues: returns zero lowered actions during dry run', () => {
  it('returns zero lowered actions during dry run', async () => {
    const member = createMigrationMember()
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    await expect(builder.dryRun()).resolves.toEqual({
      atomicity: 'plan-atomic',
      preconditions: [],
      actions: [],
    })

    expect(member.execute).not.toHaveBeenCalled()
  })
})

describe('dialect-neutral migration program preview and issues: rejects lowering issues atomically with the execution error evidence', () => {
  it('rejects lowering issues atomically with the execution error evidence', async () => {
    const member = createMigrationMember()
    const issues: ReturnType<typeof member.lower>['issues'] = [
      { code: 'compile_failure', message: 'failed second', sourceStepIndexes: [3] },
      { code: 'invalid_target', message: 'failed first', sourceStepIndexes: [1, 3] },
    ]

    member.lower.mockReturnValue({ issues })

    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    const error = await builder.dryRun().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
      sourceStepIndexes: [1, 3],
      capabilityIssues: issues,
      message: 'failed second\nfailed first',
    })

    expect(member.execute).not.toHaveBeenCalled()
  })
})

/**
 * Checks ordered, redacted physical actions without executing migration statements.
 *
 * @param preview - Physical migration preview inspected without executing its statements.
 * @param member - Optional relation-member identity or contract adapter under evaluation.
 */
function assertMigrationPreview(
  preview: Readonly<{
    atomicity: 'plan-atomic' | 'statement-atomic' | 'non-atomic'
    preconditions: MigrationProgram['preconditions']
    actions: readonly MigrationDryRunAction[]
  }>,
  member: ReturnType<typeof createMigrationMember>,
) {
  expect(preview).toEqual(
    structuredClone(returnsGroupedPhysicalActionsWithStableRedactionAndNoExecutionData),
  )

  expect('assertSession' in preview.actions[0]!.statements[0]!).toBe(false)
  expect('assertSession' in preview.actions[1]!.statements[0]!).toBe(false)
  expect(member.execute).not.toHaveBeenCalled()

  expect(member.lower).toHaveBeenCalledWith(
    expect.objectContaining({
      profile: expect.objectContaining({ identityAdapter: 'postgresql' }) as unknown,
    }),
    expect.objectContaining({ identityAdapter: 'postgresql' }),
  )
}
