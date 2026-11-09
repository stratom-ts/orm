import { string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import type { MigrationDryRunAction } from '@/ddl/migrate'
import { createMigrateBuilder } from '@/ddl/migrate'
import type {
  DialectMigrationAdapter,
  MigrationProgram,
  MigrationRuntimeOptions,
} from '@/ddl/migrationProgram'
import { postgresDialect } from '@/dialects/postgres'
import { defineTable } from '@/index'
import type { Executor } from '@/query'

import { completePostgresCatalog } from '../dialects/postgresCatalogFixtures'
import { columnTarget, indexTarget } from '../helpers/planTargets'

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
  it('should use one supplied migration member for plan and execute planning', async () => {
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
    expect(member.execute.mock.calls[0][0].lockTimeoutMs).toBeUndefined()
    expect(member.lower).toHaveBeenCalledTimes(1)

    expect(member.lower).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ identityAdapter: 'postgresql' }) as unknown,
      }),
      expect.objectContaining({ identityAdapter: 'postgresql' }),
      { columnDrop: 'guarded' },
    )
  })
})

describe('dialect-neutral migration adapter contract: keeps executing Semantic Profile validation explicit at lowering', () => {
  it('should keep executing Semantic Profile validation explicit at lowering', async () => {
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
      { columnDrop: 'guarded' },
    )
  })
})

describe('dialect-neutral migration adapter contract: validates the Semantic Profile during dry run', () => {
  it('should validate the Semantic Profile during dry run', async () => {
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
      { columnDrop: 'guarded' },
    )

    expect(member.execute).not.toHaveBeenCalled()
  })
})

describe('dialect-neutral migration program preview and issues', () => {
  it('should return grouped physical actions with stable redaction and no execution', async () => {
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
    expect(preview.actions[0].sourceStepIndexes).toEqual([1, 3])
  })
})

function memberWithCompleteColumnDropCatalog() {
  const member = createMigrationMember()
  member.introspectCatalog.mockImplementation(async (_executor, request) =>
    completePostgresCatalog(
      {
        namespaceContext,
        tables: [
          {
            schema: 'public',
            name: 'users',
            primaryKey: { name: 'users_pkey', columns: ['id'] },
            columns: [
              { name: 'id', dataType: 'text', isNullable: false },
              { name: 'email', dataType: 'text', isNullable: true },
            ],
          },
        ],
        nameReservations: [],
        constraintNameReservations: [],
      },
      request,
    ),
  )

  return member
}

function registerRealGuardedDropCase() {
  it('should lower a real guarded column drop in preview and execution', async () => {
    const Users = defineTable('users', { id: string() }, { primaryKey: 'id' })
    const member = memberWithCompleteColumnDropCatalog()

    const builder = createMigrateBuilder({
      schemas: [Users],
      migration: member.migration,
      migrationOwnership: [{ kind: 'relation', relation: Users, shape: 'complete' }],
      runOperation: createOperationRunner().runOperation,
    })

    const plan = await builder.plan()
    expect(plan.steps.map((step) => step.kind)).toContain('drop_column')
    const preview = await builder.dryRun()
    expect(preview.preconditions).toMatchObject([{ kind: 'column_has_only_nulls' }])
    await builder.execute()
    const executed = await member.execute.mock.calls[0][0].prepare()
    expect(executed.preconditions).toEqual(preview.preconditions)

    expect(
      executed.actions.map((action) =>
        action.statements.map((statement) => statement.sql),
      ),
    ).toEqual(
      preview.actions.map((action) =>
        action.statements.map((statement) => statement.sql),
      ),
    )

    builder.allow('dangerouslyDropColumn')
    expect(await builder.plan()).toEqual(plan)
    expect((await builder.dryRun()).preconditions).toEqual([])
    await builder.execute()
    expect((await member.execute.mock.calls[1][0].prepare()).preconditions).toEqual([])
  })
}

function registerTargetScopedDropCase() {
  it('should snapshot an exact dangerous column grant and keeps expand-only plan independent', async () => {
    const Users = defineTable('users', { id: string() }, { primaryKey: 'id' })
    const member = memberWithCompleteColumnDropCatalog()
    const targetBuilder = createMigrateBuilder({
      schemas: [Users],
      migration: member.migration,
      migrationOwnership: [{ kind: 'relation', relation: Users, shape: 'complete' }],
      runOperation: createOperationRunner().runOperation,
    })

    const targetPlan = await targetBuilder.plan()
    const drop = targetPlan.steps.find((step) => step.kind === 'drop_column')
    expect(drop?.kind).toBe('drop_column')

    if (drop?.kind !== 'drop_column') throw new Error('expected a column drop')

    const grantTarget = structuredClone(drop.target)
    targetBuilder.allowFor(grantTarget, 'dangerouslyDropColumn')
    Object.assign(grantTarget.column, { comparisonKey: 'mutated-after-grant' })
    expect(await targetBuilder.plan()).toEqual(targetPlan)
    expect((await targetBuilder.dryRun()).preconditions).toEqual([])
    await targetBuilder.execute()
    expect((await member.execute.mock.calls[0][0].prepare()).preconditions).toEqual([])

    const expandOnly = createMigrateBuilder({
      schemas: [Users],
      migration: member.migration,
      migrationOwnership: [{ kind: 'relation', relation: Users, shape: 'complete' }],
      runOperation: createOperationRunner().runOperation,
    }).policy('expand-only')

    await expect(expandOnly.dryRun()).rejects.toMatchObject({
      stage: 'permission',
      outcome: 'unchanged',
    })

    expect(await expandOnly.plan()).toEqual(targetPlan)
  })
}

function registerPolicyProfileCaptureCase() {
  it('should capture the selected policy profile when preview starts', async () => {
    const Users = defineTable('users', { id: string() }, { primaryKey: 'id' })
    const member = memberWithCompleteColumnDropCatalog()
    const runner = createOperationRunner()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })

    const migration = createMigrateBuilder({
      schemas: [Users],
      migration: member.migration,
      migrationOwnership: [{ kind: 'relation', relation: Users, shape: 'complete' }],
      runOperation: async (work) => {
        entered()
        await gate
        return runner.runOperation(work)
      },
    }).policy('expand-only')

    const preview = migration.dryRun()
    await started
    migration.policy('sync')
    release()

    await expect(preview).rejects.toMatchObject({
      stage: 'permission',
      outcome: 'unchanged',
    })
  })
}

const target = {
  kind: 'column' as const,
  relation: {
    namespace: [
      {
        role: 'database' as const,
        identifier: { spelling: 'test', comparisonKey: 'test' },
      },
      {
        role: 'schema' as const,
        identifier: { spelling: 'public', comparisonKey: 'public' },
      },
    ],
    relation: { spelling: 'users', comparisonKey: 'users' },
  },
  column: { spelling: 'email', comparisonKey: 'email' },
}

function memberWithGuard() {
  const member = createMigrationMember()
  const programs: MigrationProgram[] = []
  member.lower.mockImplementation((_planned, _expected, policy) => {
    const program: MigrationProgram = {
      atomicity: 'plan-atomic',
      preconditions:
        policy?.columnDrop !== 'dangerous'
          ? [
              {
                kind: 'column_has_only_nulls',
                target: structuredClone(target),
                sourceStepIndexes: [2],
              },
            ]
          : [],
      actions: [
        {
          sourceStepIndexes: [2],
          transaction: 'required',
          statements: [
            { sql: 'alter table users drop column email', params: ['secret'] },
          ],
        },
      ],
    }

    programs.push(program)
    return { program }
  })

  return { member, programs }
}

function registerPolicyPreviewCase() {
  it('should keep the semantic plan equal while preview and execution lower the selected policy', async () => {
    const { member, programs } = memberWithGuard()
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    const plan = await builder.plan()
    const guarded = await builder.dryRun()
    await builder.execute()
    expect(programs.at(-1)?.preconditions).toEqual(guarded.preconditions)

    expect(guarded.preconditions).toEqual([
      { kind: 'column_has_only_nulls', target, sourceStepIndexes: [2] },
    ])

    expect(guarded.actions[0].statements[0].params).toEqual(['[REDACTED]'])

    const guard = programs[0].preconditions[0]
    const indexes = guard.sourceStepIndexes as number[]
    indexes.push(99)

    if (guard.kind !== 'column_has_only_nulls') throw new Error('expected guard')

    Object.assign(guard.target.column, { spelling: 'changed' })

    expect(guarded.preconditions[0]).toEqual({
      kind: 'column_has_only_nulls',
      target,
      sourceStepIndexes: [2],
    })

    builder.allow('dangerouslyDropColumn')
    expect(await builder.plan()).toEqual(plan)
    const dangerous = await builder.dryRun()
    await builder.execute()
    expect(dangerous.preconditions).toEqual([])
    expect(programs.at(-1)?.preconditions).toEqual([])
    expect(dangerous.actions).toEqual(guarded.actions)
  })
}

function registerPolicyCaptureCases() {
  it.each(['execute', 'dryRun'] as const)(
    'should capture policy when %s starts',
    async (operation) => {
      const { member } = memberWithGuard()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })

      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })

      const runner = createOperationRunner()
      const builder = createMigrateBuilder({
        schemas: [],
        migration: member.migration,
        runOperation: async (work) => {
          entered()
          await gate
          return runner.runOperation(work)
        },
      })

      const first = builder[operation]()
      await started
      builder.allow('dangerouslyDropColumn')
      release()
      await first
      expect(member.lower.mock.calls[0][2]).toEqual({ columnDrop: 'guarded' })
      await builder[operation]()
      expect(member.lower.mock.calls[1][2]).toEqual({ columnDrop: 'dangerous' })
    },
  )
}

describe('column-drop policy at the public migration builder', () => {
  registerRealGuardedDropCase()
  registerTargetScopedDropCase()
  registerPolicyProfileCaptureCase()
  registerPolicyPreviewCase()
  registerPolicyCaptureCases()
})

describe('dialect-neutral migration program preview and issues: returns zero lowered actions during dry run', () => {
  it('should return zero lowered actions during dry run', async () => {
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
  it('should reject lowering issues atomically with the execution error evidence', async () => {
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

  expect('assertSession' in preview.actions[0].statements[0]).toBe(false)
  expect('assertSession' in preview.actions[1].statements[0]).toBe(false)
  expect(member.execute).not.toHaveBeenCalled()

  expect(member.lower).toHaveBeenCalledWith(
    expect.objectContaining({
      profile: expect.objectContaining({ identityAdapter: 'postgresql' }) as unknown,
    }),
    expect.objectContaining({ identityAdapter: 'postgresql' }),
    { columnDrop: 'guarded' },
  )
}

describe('migration execution policy contracts', () => {
  it('should snapshot concurrent policy before asynchronous observation', async () => {
    const member = createMigrationMember()
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    const earlier = builder.dryRun()
    builder.concurrentIndexes()

    await expect(earlier).resolves.toMatchObject({
      atomicity: 'plan-atomic',
      actions: [],
    })

    await expect(builder.plan()).resolves.toEqual({ steps: [] })

    await expect(builder.dryRun()).resolves.toMatchObject({
      atomicity: 'plan-atomic',
      actions: [],
    })

    expect(member.lower.mock.calls[0][2]).toEqual({ columnDrop: 'guarded' })

    expect(member.lower.mock.calls[1][2]).toEqual({
      columnDrop: 'guarded',
      concurrentIndexes: true,
    })
  })
})

describe('migration repair permission contracts', () => {
  it('should reject a global repair grant and repair grants on non-index targets', () => {
    const builder = createMigrateBuilder({
      schemas: [],
      migration: createMigrationMember().migration,
      runOperation: createOperationRunner().runOperation,
    })

    // @ts-expect-error Recovery cleanup is never a global permission.
    expect(() => builder.allow('repairInvalidIndex')).toThrow('requires allowFor')

    expect(() =>
      // @ts-expect-error Recovery cleanup requires an exact index target.
      builder.allowFor(columnTarget('public', 'users', 'email'), 'repairInvalidIndex'),
    ).toThrow('requires a index target')

    expect(() =>
      builder.allowFor(
        indexTarget('public', 'users', 'users_email'),
        'repairInvalidIndex',
      ),
    ).not.toThrow()
  })
})

describe('migration partial application contracts', () => {
  it('should require partial application consent even for a single forbidden action', async () => {
    const member = createMigrationMember()
    member.lower.mockReturnValue({
      program: {
        atomicity: 'non-atomic',
        preconditions: [],
        actions: [
          {
            transaction: 'forbidden',
            sourceStepIndexes: [0],
            statements: [
              { sql: 'create index concurrently example on users (email)', params: [] },
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

    await expect(builder.dryRun()).resolves.toMatchObject({ atomicity: 'non-atomic' })
    const earlier = builder.execute()
    builder.allowPartialApplication()

    await expect(earlier).rejects.toMatchObject({
      stage: 'permission',
      outcome: 'unchanged',
    })

    await expect(builder.execute()).resolves.toBeUndefined()
  })

  it('should leave an ordinary program atomic when partial application is selected', async () => {
    const member = createMigrationMember()

    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    }).allowPartialApplication()

    await expect(builder.dryRun()).resolves.toMatchObject({ atomicity: 'plan-atomic' })
    await expect(builder.execute({ statementTimeoutMs: 0 })).resolves.toBeUndefined()
    expect(member.execute.mock.calls[0][0].statementTimeoutMs).toBe(0)
  })
})

describe('migration statement timeout contracts', () => {
  it.each([-1, Infinity, NaN])(
    'should reject invalid statement timeout %s before opening a session',
    async (statementTimeoutMs) => {
      const runner = createOperationRunner()
      const builder = createMigrateBuilder({
        schemas: [],
        migration: createMigrationMember().migration,
        runOperation: runner.runOperation,
      })

      await expect(builder.execute({ statementTimeoutMs })).rejects.toMatchObject({
        outcome: 'unchanged',
        retryable: false,
      })

      expect(runner.state.calls).toBe(0)
    },
  )
})
