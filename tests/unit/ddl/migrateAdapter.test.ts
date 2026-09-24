import { describe, expect, it, vi } from 'vitest'

import { createMigrateBuilder } from '@/ddl/migrate'
import type {
  DialectMigrationAdapter,
  MigrationRuntimeOptions,
} from '@/ddl/migrationProgram'
import { postgresDialect } from '@/dialects/postgres'
import type { Executor } from '@/query'

import { completePostgresCatalog } from '../helpers/catalog'

const namespaceContext = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

const executor: Executor = {
  async execute() {
    return []
  },
  async run() {
    return undefined
  },
}

function createOperationRunner() {
  const state = { calls: 0 }

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
      vi.fn(),
      vi.fn(async () => undefined),
    )
  }

  return { runOperation, state }
}

function createMigrationMember(identityAdapter = 'postgresql') {
  const selected = postgresDialect.migration
  const createIdentity = vi.fn(selected.planning.identity.create)
  const introspectCatalog = vi.fn(
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
  const lower = vi.fn(selected.lower)
  const execute = vi.fn(async (options: MigrationRuntimeOptions) => {
    const program = await options.prepare()
    return {
      outcome:
        program.actions.length === 0 ? ('unchanged' as const) : ('applied' as const),
    }
  })
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
  it('uses one supplied migration member for dry-run and execute planning', async () => {
    const member = createMigrationMember()
    const operationRunner = createOperationRunner()
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: operationRunner.runOperation,
    })

    await expect(builder.dryRun()).resolves.toEqual({ steps: [] })
    await expect(builder.execute()).resolves.toBeUndefined()

    expect(operationRunner.state.calls).toBe(2)
    expect(member.introspectCatalog).toHaveBeenCalledTimes(2)
    expect(member.createIdentity).toHaveBeenCalledTimes(2)
    expect(member.execute).toHaveBeenCalledTimes(1)
    expect(member.execute.mock.calls[0]![0].lockTimeoutMs).toBeUndefined()
    expect(member.lower).toHaveBeenCalledTimes(1)
    expect(member.lower).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ identityAdapter: 'postgresql' }),
      }),
      expect.objectContaining({ identityAdapter: 'postgresql' }),
    )
  })

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
        profile: expect.objectContaining({ identityAdapter: 'not-postgresql' }),
      }),
      expect.objectContaining({ identityAdapter: 'not-postgresql' }),
    )
  })

  it('validates the Semantic Profile during preview', async () => {
    const member = createMigrationMember('not-postgresql')
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    const error = await builder.preview().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
      message: "Executing profile adapter 'not-postgresql' does not match PostgreSQL",
    })
    expect(member.lower).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ identityAdapter: 'not-postgresql' }),
      }),
      expect.objectContaining({ identityAdapter: 'not-postgresql' }),
    )
    expect(member.execute).not.toHaveBeenCalled()
  })

  it('previews grouped physical actions with stable redaction and no execution', async () => {
    const member = createMigrationMember()
    const sourceStepIndexes = [1, 3]
    member.lower.mockReturnValue({
      program: {
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
            sourceStepIndexes,
            transaction: 'allowed',
            statements: [
              {
                sql: 'alter table x add column a text',
                params: ['secret', 42],
                assertSession: vi.fn(),
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

    const preview = await builder.preview()

    expect(preview).toEqual({
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
          statements: [
            { sql: 'create index users_email_idx on users (email)', params: [] },
          ],
        },
      ],
    })
    expect('assertSession' in preview.actions[0]!.statements[0]!).toBe(false)
    expect('assertSession' in preview.actions[1]!.statements[0]!).toBe(false)
    expect(member.execute).not.toHaveBeenCalled()
    expect(member.lower).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ identityAdapter: 'postgresql' }),
      }),
      expect.objectContaining({ identityAdapter: 'postgresql' }),
    )

    sourceStepIndexes.push(99)
    expect(preview.actions[0]!.sourceStepIndexes).toEqual([1, 3])
  })

  it('previews zero lowered actions', async () => {
    const member = createMigrationMember()
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    await expect(builder.preview()).resolves.toEqual({
      atomicity: 'plan-atomic',
      preconditions: [],
      actions: [],
    })
    expect(member.execute).not.toHaveBeenCalled()
  })

  it('rejects lowering issues atomically with the execution error evidence', async () => {
    const member = createMigrationMember()
    member.lower.mockReturnValue({
      issues: [
        { code: 'compile_failure', message: 'failed second', sourceStepIndexes: [3] },
        { code: 'invalid_target', message: 'failed first', sourceStepIndexes: [1, 3] },
      ],
    })
    const builder = createMigrateBuilder({
      schemas: [],
      migration: member.migration,
      runOperation: createOperationRunner().runOperation,
    })

    const error = await builder.preview().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
      sourceStepIndexes: [1, 3],
      capabilityIssues: member.lower.mock.results[0]!.value.issues,
      message: 'failed second\nfailed first',
    })
    expect(member.execute).not.toHaveBeenCalled()
  })
})
