import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import type { MigrationError, OperationSessionProvider } from '@/index'
import { DriverError, column, createDatabase, defineTable } from '@/index'

import { deferred } from '../helpers/deferredPromise'

import { customConnector } from './helpers/operationSessionFixtures'
import { createPostgresControllableProvider } from './helpers/postgresOperationSessionFixtures'

/** Checks that migration context hides driver text while retaining native diagnostics. */
function expectSafeDriverDiagnostics(
  error: MigrationError,
  driver: DriverError,
  native: Error,
  secret: string,
): void {
  expect(error.message).not.toContain(secret)
  expect(error.cause).toBe(driver)
  expect(driver.cause).toBe(native)
  expect(JSON.stringify(error)).toContain(secret)
}

describe('driver migration classification', () => {
  it('should retain a driver failure as the cause of a staged migration error', async () => {
    const secret = 'sensitive-driver-detail'
    const native = Object.assign(new Error(`native DDL failure: ${secret}`), {
      code: '23505',
    })

    const driver = new DriverError({
      message: native.message,
      dialect: 'postgresql',
      code: native.code,
      sql: 'create table driver_events',
      cause: native,
      kind: 'uniqueViolation',
      retryable: false,
    })

    const controls = createPostgresControllableProvider({
      /** Fails at the physical DDL call. */
      beforeCall: async (_session, sql) => {
        if (/^create table/i.test(sql)) throw driver
      },
    })

    const Events = defineTable(
      'driver_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )

    const db = createDatabase({
      connector: customConnector('postgresql'),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    try {
      const error = await db
        .migrate()
        .execute()
        .catch((cause: unknown) => cause)

      expect(error).toMatchObject({
        _tag: 'MigrationError',
        stage: 'ddl',
        outcome: 'rolledBack',
        cause: driver,
      })

      expectSafeDriverDiagnostics(error as MigrationError, driver, native, secret)
      expect((error as MigrationError).defect).toBeUndefined()
    } finally {
      await db.close()
    }
  })
})

describe('public migration execution and session cleanup', () => {
  it('should exclude queries from complete migration DDL and cleanup', async () => {
    const ddlStarted = deferred()
    const finishDdl = deferred()
    const controls = createPostgresControllableProvider({
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
      connector: customConnector('postgresql'),
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
  it('should discard a migration session when rollback and unlock cleanup fail', async () => {
    const primary = new Error('primary DDL failure')
    const rollbackFailure = new Error('rollback cleanup failure')
    const unlockFailure = new Error('unlock cleanup failure')
    const controls = createPostgresControllableProvider({
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
      connector: customConnector('postgresql'),
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
  it('should keep a DDL failure primary when rollback cancellation also fails', async () => {
    const primary = new Error('primary DDL failure before rollback cancellation')
    const cancellationFailure = new Error('session cancellation cleanup failed')
    const controller = new AbortController()
    const rollbackStarted = deferred()
    const finishRollback = deferred()
    const controls = createPostgresControllableProvider({
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
      connector: customConnector('postgresql'),
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
  it('should keep a runtime DDL failure primary when provider release also fails', async () => {
    const primaryCause = new Error('primary runtime DDL failure')
    const primaryStack = primaryCause.stack
    const releaseCause = new Error('secondary provider release failure')
    const controls = createPostgresControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/^create table/i.test(sql)) throw primaryCause
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
      connector: customConnector('postgresql'),
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
      actionIndex: 0,
      cleanupFailures: [{ stage: 'sessionCleanup', cause: releaseCause }],
    })

    expect((error as Error).message).toBe(
      'PostgreSQL migration ddl failed during action 1',
    )

    expect((error as MigrationError).cause).toBe(primaryCause)
    expect(((error as MigrationError).cause as Error).stack).toBe(primaryStack)
    expect((error as MigrationError).cleanupFailures?.[0]?.cause).toBe(releaseCause)

    expect(((error as MigrationError).cause as Error).message).toMatch(
      /primary runtime DDL failure/i,
    )

    expect((error as Error).message).not.toMatch(/secondary provider release failure/i)
    await db.close()
  })
})

describe('public migration coordination failures', () => {
  it('should normalize provider-open failure before the migration callback', async () => {
    const openCause = new Error('migration provider open failed')
    const controls = createPostgresControllableProvider({
      openFailure: { session: 1, value: openCause },
    })

    const db = createDatabase({
      connector: customConnector('postgresql'),
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
      cause: openCause,
    })

    expect((error as Error).cause).toBe(openCause)
    expect((error as MigrationError).cleanupFailures).toBeUndefined()
    expect(controls.events).toEqual(['lease-opened:1'])
    expect((error as Error).message).toBe('Migration operation session failed')

    await db.close()
  })
})

describe('public migration coordination failures: reports advisory unlock failure after a committed no-op and discards', () => {
  it('should report advisory unlock failure after a committed no-op and discard', async () => {
    const controls = createPostgresControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/pg_advisory_unlock/i.test(sql)) throw new Error('unlock cleanup failure')
      },
    })

    const db = createDatabase({
      connector: customConnector('postgresql'),
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
  it('should report an unverified advisory unlock and discard', async () => {
    const controls = createPostgresControllableProvider({ unlockResult: false })
    const db = createDatabase({
      connector: customConnector('postgresql'),
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
  it('should discard after migration lock acquisition fails', async () => {
    const lockCause = new Error('lock acquisition failure')
    const controls = createPostgresControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/pg_try_advisory_lock\(/i.test(sql)) {
          throw lockCause
        }
      },
    })

    const db = createDatabase({
      connector: customConnector('postgresql'),
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

    expect((error as Error).message).toMatch(/PostgreSQL migration lock failed/i)
    expect((error as MigrationError).cause).toBe(lockCause)
    expect(controls.events).toContain('release-started:1:discard')

    expect(controls.calls.some((entry) => /pg_advisory_unlock/i.test(entry.sql))).toBe(
      false,
    )

    await db.close()
  })
})

describe('public migration coordination failures: cancels the physical session when a lock try never settles', () => {
  it('should cancel the physical session when a lock try never settles', async () => {
    const lockStarted = deferred()
    let rejectLock!: (cause: Error) => void
    const hangingLock = new Promise<void>((_, reject) => {
      rejectLock = reject
    })

    const controls = createPostgresControllableProvider({
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
      connector: customConnector('postgresql'),
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
  it('should discard after an ambiguous migration commit failure', async () => {
    const commitCause = new Error('commit outcome unknown')
    const controls = createPostgresControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/^commit$/i.test(sql)) throw commitCause
      },
    })

    const Events = defineTable(
      'ambiguous_commit_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )

    const db = createDatabase({
      connector: customConnector('postgresql'),
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

    expect((error as Error).message).toMatch(/PostgreSQL migration commit failed/i)
    expect((error as MigrationError).cause).toBe(commitCause)
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
    cause: primary,
    defect: true,
    stage: 'ddl',
    outcome: 'unknown',
    cleanupFailures: [
      {
        stage: 'rollback',
        cause: expect.objectContaining({
          message: 'Migration execution was aborted',
        }) as unknown,
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
    cause: primary,
    defect: true,
    stage: 'ddl',
    outcome: 'unknown',
    cleanupFailures: [
      { stage: 'rollback', cause: rollbackFailure },
      { stage: 'unlock', cause: unlockFailure },
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
