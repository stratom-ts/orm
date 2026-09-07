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
})
