import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import type { OperationSessionProvider } from '@/index'
import { column, createDatabase, defineTable } from '@/index'

import { deferred } from '../helpers/deferredPromise'

import {
  createControllableProvider,
  customConnector,
} from './helpers/operationSessionFixtures'

describe('public migration execution and session cleanup', () => {
  it('excludes queries from complete migration DDL and cleanup', async () => {
    const ddlStarted = deferred()
    const finishDdl = deferred()
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/^create table/i.test(sql)) {
          ddlStarted.resolve()
          await finishDdl.promise
        }
      },
    })
    const Events = defineTable(
      'operation_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    const migration = db.migrate().execute()
    await ddlStarted.promise
    const query = db.ping()
    await Promise.resolve()
    expect(controls.openCount).toBe(1)
    finishDdl.resolve()
    await migration
    await query

    const firstRelease = controls.events.indexOf('release-finished:1:reuse')
    const secondOpen = controls.events.indexOf('lease-opened:2')
    expect(firstRelease).toBeGreaterThan(-1)
    expect(secondOpen).toBeGreaterThan(firstRelease)

    expect(
      controls.calls
        .filter((entry) => entry.session === 1)
        .some((entry) => /pg_advisory_unlock/i.test(entry.sql)),
    ).toBe(true)

    await db.close()
  })
})

describe('public migration execution and session cleanup: discards a migration session when rollback and unlock cleanup fail', () => {
  it('discards a migration session when rollback and unlock cleanup fail', async () => {
    const primary = new Error('primary DDL failure')
    const rollbackFailure = new Error('rollback cleanup failure')
    const unlockFailure = new Error('unlock cleanup failure')
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/^create table/i.test(sql)) throw primary
        if (/^rollback$/i.test(sql)) throw rollbackFailure
        if (/pg_advisory_unlock/i.test(sql)) throw unlockFailure
      },
    })
    const Events = defineTable(
      'cleanup_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)

    assertMigrationCleanupFailures(
      error,
      primary,
      rollbackFailure,
      unlockFailure,
      controls,
    )

    await db.close()
  })
})

describe('public migration execution and session cleanup: keeps a DDL failure primary when rollback cancellation also fails', () => {
  it('keeps a DDL failure primary when rollback cancellation also fails', async () => {
    const primary = new Error('primary DDL failure before rollback cancellation')
    const cancellationFailure = new Error('session cancellation cleanup failed')
    const controller = new AbortController()
    const rollbackStarted = deferred()
    const finishRollback = deferred()
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/^create table/i.test(sql)) throw primary
        if (!/^rollback$/i.test(sql)) return

        rollbackStarted.resolve()
        await finishRollback.promise
      },
      /** Signals or holds cancellation to expose the requested concurrency scenario. */
      beforeCancel: async () => {
        finishRollback.resolve()
        throw cancellationFailure
      },
    })
    const Events = defineTable(
      'cancellation_cleanup_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    const migration = db.migrate().execute({ signal: controller.signal })
    await rollbackStarted.promise
    controller.abort()
    const error = await migration.catch((cause: unknown) => cause)

    assertRollbackCancellationFailure(error, primary, cancellationFailure, controls)

    await db.close()
  })
})

describe('public migration execution and session cleanup: keeps a DDL failure primary when rollback cancellation also fails: keeps a runtime DDL failure primary when provider release also fails', () => {
  it('keeps a runtime DDL failure primary when provider release also fails', async () => {
    const releaseCause = new Error('secondary provider release failure')
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/^create table/i.test(sql)) throw new Error('primary runtime DDL failure')
      },
      releaseFailure: {
        session: 1,
        value: releaseCause,
      },
    })
    const Events = defineTable(
      'primary_runtime_failure_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'ddl',
      outcome: 'rolledBack',
      retryable: false,
      cleanupFailures: [{ stage: 'sessionCleanup', cause: releaseCause }],
    })

    expect((error as Error).message).toMatch(/primary runtime DDL failure/i)
    expect((error as Error).message).not.toMatch(/secondary provider release failure/i)
    await db.close()
  })
})

describe('public migration coordination failures', () => {
  it('normalizes provider-open failure before the migration callback', async () => {
    const openCause = new Error('migration provider open failed')
    const controls = createControllableProvider({
      openFailure: { session: 1, value: openCause },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'sessionCleanup',
      outcome: 'unchanged',
      retryable: false,
      cleanupFailures: [{ stage: 'sessionCleanup', cause: openCause }],
    })

    await db.close()
  })
})

describe('public migration coordination failures: reports advisory unlock failure after a committed no-op and discards', () => {
  it('reports advisory unlock failure after a committed no-op and discards', async () => {
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/pg_advisory_unlock/i.test(sql)) throw new Error('unlock cleanup failure')
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'unlock',
      outcome: 'unchanged',
      retryable: false,
      cleanupFailures: [{ stage: 'unlock' }],
    })

    expect(controls.events).toContain('release-started:1:discard')
    await db.close()
  })
})

describe('public migration coordination failures: reports an unverified advisory unlock and discards', () => {
  it('reports an unverified advisory unlock and discards', async () => {
    const controls = createControllableProvider({ unlockResult: false })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'unlock',
      outcome: 'unchanged',
      retryable: false,
    })

    expect(controls.events).toContain('release-started:1:discard')
    await db.close()
  })
})

describe('public migration coordination failures: discards after migration lock acquisition fails', () => {
  it('discards after migration lock acquisition fails', async () => {
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/pg_try_advisory_lock\(/i.test(sql)) {
          throw new Error('lock acquisition failure')
        }
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'lock',
      outcome: 'unchanged',
      retryable: false,
    })

    expect((error as Error).message).toMatch(/lock acquisition failure/i)
    expect(controls.events).toContain('release-started:1:discard')

    expect(controls.calls.some((entry) => /pg_advisory_unlock/i.test(entry.sql))).toBe(
      false,
    )

    await db.close()
  })
})

describe('public migration coordination failures: cancels the physical session when a lock try never settles', () => {
  it('cancels the physical session when a lock try never settles', async () => {
    const lockStarted = deferred()
    let rejectLock!: (cause: Error) => void
    const hangingLock = new Promise<void>((_, reject) => {
      rejectLock = reject
    })
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/pg_try_advisory_lock/i.test(sql)) {
          lockStarted.resolve()
          await hangingLock
        }
      },
      /** Signals or holds cancellation to expose the requested concurrency scenario. */
      beforeCancel: async () => {
        rejectLock(new Error('cancelled hanging lock query'))
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const controller = new AbortController()
    const migration = db.migrate().execute({ signal: controller.signal })
    await lockStarted.promise
    controller.abort()
    const error = await migration.catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })

    expect(controls.events).toContain('cancel-requested:1')
    expect(controls.events).toContain('release-started:1:discard')

    expect(
      controls.calls.some((entry) => /^begin|pg_advisory_unlock/i.test(entry.sql)),
    ).toBe(false)

    await db.close()
  })
})

describe('public migration coordination failures: cancels the physical session when a lock try never settles: discards after an ambiguous migration commit failure', () => {
  it('discards after an ambiguous migration commit failure', async () => {
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/^commit$/i.test(sql)) throw new Error('commit outcome unknown')
      },
    })
    const Events = defineTable(
      'ambiguous_commit_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'commit',
      outcome: 'unknown',
      retryable: false,
    })

    expect((error as Error).message).toMatch(/commit outcome unknown/i)
    expect(controls.calls.some((entry) => /^rollback$/i.test(entry.sql))).toBe(false)
    expect(controls.events).toContain('release-started:1:discard')
    await db.close()
  })
})

/**
 * Checks that DDL failure remains primary when rollback cancellation also fails.
 *
 * @param error - Primary operation rejection, including primitive or undefined values.
 * @param primary - Primary operation rejection that cleanup must preserve.
 * @param cancellationFailure - Rejection injected into physical-query cancellation.
 * @param controls - Mutable test observations and synchronization controls.
 */
function assertRollbackCancellationFailure(
  error: unknown,
  primary: Error,
  cancellationFailure: Error,
  controls: {
    provider: OperationSessionProvider
    events: string[]
    calls: { session: number; sql: string }[]
    readonly openCount: number
    readonly maxActiveCalls: number
    readonly closeCount: number
  },
) {
  expect(error).toMatchObject({
    _tag: 'MigrationError',
    cause: { cause: primary },
    stage: 'ddl',
    outcome: 'unknown',
    cleanupFailures: [
      {
        stage: 'rollback',
        cause: expect.objectContaining({
          message: 'Migration execution was aborted',
        }),
      },
      { stage: 'sessionCleanup', cause: cancellationFailure },
    ],
  })

  expect(controls.events).toContain('cancel-requested:1')
  expect(controls.events).toContain('release-started:1:discard')
}

/**
 * Checks discarded sessions and retained rollback and advisory-lock cleanup evidence.
 *
 * @param error - Primary operation rejection, including primitive or undefined values.
 * @param primary - Primary operation rejection that cleanup must preserve.
 * @param rollbackFailure - Rejection injected into transaction rollback.
 * @param unlockFailure - Rejection injected into advisory-lock release.
 * @param controls - Mutable test observations and synchronization controls.
 */
function assertMigrationCleanupFailures(
  error: unknown,
  primary: Error,
  rollbackFailure: Error,
  unlockFailure: Error,
  controls: {
    provider: OperationSessionProvider
    events: string[]
    calls: { session: number; sql: string }[]
    readonly openCount: number
    readonly maxActiveCalls: number
    readonly closeCount: number
  },
) {
  expect(error).toMatchObject({
    _tag: 'MigrationError',
    cause: { cause: primary },
    stage: 'ddl',
    outcome: 'unknown',
    cleanupFailures: [
      { stage: 'rollback', cause: { cause: rollbackFailure } },
      { stage: 'unlock', cause: { cause: unlockFailure } },
    ],
  })

  expect(
    controls.calls
      .map(({ sql }) => {
        if (/^rollback$/i.test(sql)) return 'rollback'
        if (/pg_advisory_unlock/i.test(sql)) return 'unlock'

        return undefined
      })
      .filter((phase) => phase !== undefined),
  ).toEqual(['rollback', 'unlock'])

  expect(controls.events).toContain('release-started:1:discard')
}
