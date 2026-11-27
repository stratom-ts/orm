import { number } from 'valibot'
import { expect, expectTypeOf, it, vi } from 'vitest'

import { QueryError, createDatabase, defineTable } from '@/index'
import type { Cursor, ValueMapConfig } from '@/index'
import { operationCleanupFailures, operationPrimaryFailure } from '@/operations/cleanup'

import { deferred } from '../helpers/deferredPromise'

import {
  createControllableProvider,
  customConnector,
  withDeadline,
} from './helpers/operationSessionFixtures'

const Items = defineTable('cursor_items', { id: number() }, { primaryKey: 'id' })
function fixture(
  options?: Parameters<typeof createControllableProvider>[0],
  dialect: 'postgresql' | 'sqlite' = 'postgresql',
  map?: ValueMapConfig,
) {
  const controls = createControllableProvider(options)
  const db = createDatabase({
    connector: customConnector(dialect),
    operationSessionProvider: controls.provider,
    schemas: [Items],
    map,
  })

  return { db, controls }
}

it('should be lazy, rejects root use, and never invokes an unsupported callback', async () => {
  const { db, controls } = fixture()
  const callback = vi.fn<() => Promise<number>>(async () => 1)
  const iterator = db.from(Items).batches()
  expect(controls.calls).toEqual([])
  await expect(iterator.next()).rejects.toBeInstanceOf(QueryError)
  await expect(db.from(Items).withCursor(callback)).rejects.toBeInstanceOf(QueryError)
  expect(callback).not.toHaveBeenCalled()
  expect(controls.calls).toEqual([])
  await db.close()
})

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'should reject invalid count %s before SQL',
  async (count) => {
    const { db, controls } = fixture()
    await db.transaction(async (tx) => {
      await expect(
        tx.from(Items).batches({ batchSize: count }).next(),
      ).rejects.toBeInstanceOf(QueryError)

      await tx.from(Items).withCursor(async (cursor) => {
        await expect(cursor.fetch(count)).rejects.toBeInstanceOf(QueryError)
      })
    })

    expect(controls.calls.some((call) => call.sql.startsWith('FETCH'))).toBe(false)
    await db.close()
  },
)

it('should serialize accepted fetches before close and rejects fetches after close', async () => {
  const entered = deferred()
  const release = deferred()
  const { db, controls } = fixture({
    queryRows: () => [{ id: 1 }],
    beforeCall: async (_, sql) => {
      if (sql.startsWith('FETCH')) {
        entered.resolve()
        await release.promise
      }
    },
  })

  await withDeadline(
    db.transaction(async (tx) => {
      await tx.from(Items).withCursor(async (cursor) => {
        const first = cursor.fetch(1)
        await entered.promise
        const second = cursor.fetch(1)
        const closing = cursor.close()
        await expect(cursor.fetch(1)).rejects.toThrow(/closed/)
        release.resolve()

        await expect(Promise.all([first, second])).resolves.toEqual([
          [{ id: 1 }],
          [{ id: 1 }],
        ])

        await closing
        await cursor.close()
      })
    }),
  )

  expect(controls.calls.map((call) => call.sql.split(' ')[0])).toEqual([
    'begin',
    'DECLARE',
    'FETCH',
    'FETCH',
    'CLOSE',
    'commit',
  ])

  expect(controls.maxActiveCalls).toBe(1)
  await db.close()
})

it('should close abandoned iterators at transaction exit and invalidates escaped handles', async () => {
  const { db, controls } = fixture({ queryRows: () => [{ id: 1 }] })
  let escaped!: Cursor<{ id: number }>
  let iterator!: AsyncIterableIterator<{ id: number }[]>
  await db.transaction(async (tx) => {
    iterator = tx.from(Items).batches({ batchSize: 1 })
    await iterator.next()
    const result = await tx.from(Items).withCursor(async (cursor) => {
      escaped = cursor
      return 'complete' as const
    })

    expectTypeOf(result).toEqualTypeOf<'complete'>()
    expectTypeOf(iterator).toEqualTypeOf<AsyncIterableIterator<{ id: number }[]>>()
    expect(result).toBe('complete')
  })

  await expect(escaped.fetch(1)).rejects.toThrow(/closed/)
  await expect(iterator.next()).rejects.toThrow(/closed/)
  expect(controls.calls.filter((call) => call.sql.startsWith('CLOSE'))).toHaveLength(2)
  expect(controls.calls.at(-1)?.sql).toBe('commit')
  await db.close()
})

it('should close child cursors on success, invalidates on rollback, and guards ancestor ownership', async () => {
  const { db, controls } = fixture({ queryRows: () => [{ id: 1 }] })
  const failure = new Error('rollback child')
  await withDeadline(
    db.transaction(async (tx) => {
      await tx.from(Items).withCursor(async (ancestor) => {
        await tx.transaction(async (child) => {
          await expect(ancestor.fetch(1)).rejects.toThrow(/nested callback client/)
          await child.from(Items).batches({ batchSize: 1 }).next()
        })

        await expect(
          tx.transaction(async (child) => {
            await child.from(Items).batches({ batchSize: 1 }).next()
            throw failure
          }),
        ).rejects.toBe(failure)

        await expect(ancestor.fetch(1)).resolves.toEqual([{ id: 1 }])
      })
    }),
  )

  const sql = controls.calls.map((call) => call.sql)
  expect(sql.filter((sql) => sql.startsWith('CLOSE'))).toHaveLength(2)

  expect(sql).toContain('CLOSE "stratom_cursor_2"')

  expect(sql.indexOf('CLOSE "stratom_cursor_2"')).toBeLessThan(
    sql.indexOf('release savepoint sp_1'),
  )

  await db.close()
})

it('should reject SQLite transactions before callback execution', async () => {
  const { db, controls } = fixture(undefined, 'sqlite')
  const callback = vi.fn<() => Promise<void>>(async () => undefined)
  await db.transaction(async (tx) => {
    await expect(tx.from(Items).withCursor(callback)).rejects.toThrow(/dialect/)
  })

  expect(callback).not.toHaveBeenCalled()
  expect(controls.calls.map((call) => call.sql)).toEqual(['begin', 'commit'])
  await db.close()
})

it('should reject pre-aborted signals without declaration', async () => {
  const { db, controls } = fixture()
  const reason = new Error('stop')
  const callback = vi.fn<() => Promise<void>>(async () => undefined)
  await db.transaction(async (tx) => {
    await expect(
      tx.from(Items).withCursor(callback, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason)
  })

  expect(callback).not.toHaveBeenCalled()
  expect(controls.calls.map((call) => call.sql)).toEqual(['begin', 'commit'])
  await db.close()
})

it('should cancel only its active physical fetch, poisons the transaction, and discards', async () => {
  const entered = deferred()
  const release = deferred()
  const abort = new AbortController()
  const reason = new Error('cancel fetch')
  const { db, controls } = fixture({
    queryRows: () => [{ id: 1 }],
    beforeCall: async (_, sql) => {
      if (sql.startsWith('FETCH')) {
        entered.resolve()
        await release.promise
      }
    },
    beforeCancel: async () => {
      release.resolve()
    },
  })

  await expect(
    withDeadline(
      db.transaction(async (tx) => {
        await tx.from(Items).withCursor(
          async (cursor) => {
            const fetching = cursor.fetch(1)
            await entered.promise
            abort.abort(reason)
            await expect(fetching).rejects.toBe(reason)
            await expect(tx.ping()).rejects.toThrow(/no longer usable/)
          },
          { signal: abort.signal },
        )
      }),
    ),
  ).rejects.toBe(reason)

  expect(controls.events).toContain('cancel-requested:1')
  expect(controls.events).toContain('release-finished:1:discard')
  expect(controls.calls.some((call) => call.sql.startsWith('CLOSE'))).toBe(false)
  await db.close()
})

it('should avoid cancelling an unrelated statement when aborted between fetches', async () => {
  const abort = new AbortController()
  const reason = new Error('idle abort')
  const { db, controls } = fixture({
    beforeCall: async (_, sql) => {
      if (sql === 'select 1') abort.abort(reason)
    },
  })

  await expect(
    db.transaction(async (tx) => {
      await tx.from(Items).withCursor(
        async (cursor) => {
          await tx.ping()
          await expect(cursor.fetch(1)).rejects.toBe(reason)
        },
        { signal: abort.signal },
      )
    }),
  ).rejects.toBe(reason)

  expect(controls.events).not.toContain('cancel-requested:1')
  expect(controls.calls.some((call) => call.sql.startsWith('CLOSE'))).toBe(true)
  await db.close()
})

it('should preserve callback identity and records secondary cleanup failure', async () => {
  const primary = Object.freeze(new Error('callback'))
  const cleanup = new Error('close')
  const { db, controls } = fixture({
    beforeCall: async (_, sql) => {
      if (sql.startsWith('CLOSE')) throw cleanup
    },
  })

  await expect(
    db.transaction((tx) =>
      tx.from(Items).withCursor(async () => {
        throw primary
      }),
    ),
  ).rejects.toMatchObject({ cause: primary, cleanupFailures: [{ cause: cleanup }] })

  expect(controls.events).toContain('release-finished:1:discard')
  expect(controls.calls.some((call) => call.sql === 'commit')).toBe(false)
  await db.close()
})

it('should close immediately on a mapping defect and preserve its identity', async () => {
  const failure = Object.freeze(new Error('mapper'))
  const { db, controls } = fixture({ queryRows: () => [{ id: 1 }] }, 'postgresql', {
    mapResultValue: () => {
      throw failure
    },
  })

  await db.transaction(async (tx) => {
    await tx.from(Items).withCursor(async (cursor) => {
      await expect(cursor.fetch(1)).rejects.toBe(failure)
      await expect(cursor.fetch(1)).rejects.toThrow(/closed/)
      await tx.ping()
    })
  })

  expect(controls.calls.filter((call) => call.sql.startsWith('CLOSE'))).toHaveLength(1)
  await db.close()
})

it('should use the default batch size and preserve a callback rejection', async () => {
  const { db, controls } = fixture()
  const failure = Symbol('callback')
  await db.transaction(async (tx) => {
    expect((await tx.from(Items).batches().next()).done).toBe(true)

    await expect(
      tx.from(Items).withCursor(async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
  })

  expect(controls.calls.find((call) => call.sql.startsWith('FETCH'))?.sql).toMatch(
    /^FETCH FORWARD 100 /,
  )

  await db.close()
})

it('should abort declaration without invoking the callback', async () => {
  const abort = new AbortController()
  const reason = new Error('declare aborted')
  const { db, controls } = fixture({
    beforeCall: async (_, sql) => {
      if (sql.startsWith('DECLARE')) abort.abort(reason)
    },
  })

  const callback = vi.fn<() => Promise<void>>(async () => undefined)
  await expect(
    db.transaction((tx) => tx.from(Items).withCursor(callback, { signal: abort.signal })),
  ).rejects.toBe(reason)

  expect(callback).not.toHaveBeenCalled()
  expect(controls.events).toContain('release-finished:1:discard')
  await db.close()
})

it('should reject a queued declaration abort without cancelling another active query', async () => {
  const entered = deferred()
  const release = deferred()
  const abort = new AbortController()
  const reason = new Error('queued aborted')
  const { db, controls } = fixture({
    beforeCall: async (_, sql) => {
      if (sql === 'select 1') {
        entered.resolve()
        await release.promise
      }
    },
  })

  await withDeadline(
    db.transaction(async (tx) => {
      const query = tx.ping()
      await entered.promise

      const cursor = tx
        .from(Items)
        .withCursor(async () => undefined, { signal: abort.signal })

      abort.abort(reason)
      release.resolve()
      await query
      await expect(cursor).rejects.toBe(reason)
    }),
  )

  expect(controls.events).not.toContain('cancel-requested:1')
  expect(controls.calls.some((call) => call.sql.startsWith('DECLARE'))).toBe(false)
  await db.close()
})

it('should drain an active cancelled fetch before resolving an already queued close', async () => {
  const entered = deferred()
  const release = deferred()
  const abort = new AbortController()
  const reason = new Error('cancel queued close')
  const { db, controls } = fixture({
    queryRows: () => [{ id: 1 }],
    beforeCall: async (_, sql) => {
      if (sql.startsWith('FETCH')) {
        entered.resolve()
        await release.promise
      }
    },
    beforeCancel: async () => {
      release.resolve()
    },
  })

  await expect(
    withDeadline(
      db.transaction((tx) =>
        tx.from(Items).withCursor(
          async (cursor) => {
            const fetching = cursor.fetch(1)
            await entered.promise
            const closing = cursor.close()
            abort.abort(reason)
            await expect(fetching).rejects.toBe(reason)
            await expect(closing).resolves.toBeUndefined()
          },
          { signal: abort.signal },
        ),
      ),
    ),
  ).rejects.toBe(reason)

  expect(controls.events).toContain('release-finished:1:discard')
  await db.close()
})

it('should fail commit when closing an abandoned iterator fails', async () => {
  const failure = new Error('abandoned close')
  const { db, controls } = fixture({
    queryRows: () => [{ id: 1 }],
    beforeCall: async (_, sql) => {
      if (sql.startsWith('CLOSE')) throw failure
    },
  })

  await expect(
    db.transaction(async (tx) => {
      await tx.from(Items).batches({ batchSize: 1 }).next()
    }),
  ).rejects.toBe(failure)

  expect(controls.calls.some((call) => call.sql === 'commit')).toBe(false)
  expect(controls.events).toContain('release-finished:1:discard')
  await db.close()
})

it('should retain abort identity and cancellation failure diagnostics', async () => {
  const abort = new AbortController()
  const primary = new Error('abort')
  const cleanup = new Error('cancel failed')
  const { db, controls } = fixture({
    beforeCall: async (_, sql) => {
      if (sql.startsWith('DECLARE')) abort.abort(primary)
    },
    beforeCancel: async () => {
      throw cleanup
    },
  })

  await expect(
    db.transaction((tx) =>
      tx.from(Items).withCursor(async () => undefined, { signal: abort.signal }),
    ),
  ).rejects.toMatchObject({ cause: primary, cleanupFailures: [{ cause: cleanup }] })

  expect(controls.events).toContain('release-finished:1:discard')
  await db.close()
})

it.each([Object.freeze(new Error('loop body')), 'loop body'])(
  'should retain loop body failure %s and one close failure at scope exit',
  async (primary) => {
    const cleanup = new Error('close failed')
    const { db, controls } = fixture({
      queryRows: () => [{ id: 1 }],
      beforeCall: async (_, sql) => {
        if (sql.startsWith('CLOSE')) throw cleanup
      },
    })

    const received: unknown[] = []
    const rejection = await db
      .transaction(async (tx) => {
        for await (const batch of tx.from(Items).batches({ batchSize: 1 })) {
          received.push(batch)
          await rejectLoopBody(primary)
        }
      })
      .catch((error: unknown) => error)

    expect(received).toEqual([[{ id: 1 }]])
    expect(operationPrimaryFailure(rejection)).toBe(primary)
    expect(operationCleanupFailures(rejection)).toHaveLength(1)

    expect(rejection).toMatchObject({
      cause: primary,
      cleanupFailures: [{ cause: cleanup }],
    })

    expect(controls.calls.filter((call) => call.sql.startsWith('CLOSE'))).toHaveLength(1)
    expect(controls.calls.some((call) => call.sql === 'commit')).toBe(false)
    expect(controls.events).toContain('release-finished:1:discard')
    await db.close()
  },
)

it('should attach a single close failure once across mapping, terminal and scope cleanup', async () => {
  const primary = Object.freeze(new Error('mapping'))
  const cleanup = new Error('close failed')
  const { db, controls } = fixture(
    {
      queryRows: () => [{ id: 1 }],
      beforeCall: async (_, sql) => {
        if (sql.startsWith('CLOSE')) throw cleanup
      },
    },
    'postgresql',
    {
      mapResultValue: () => {
        throw primary
      },
    },
  )

  const rejection = await db
    .transaction((tx) =>
      tx.from(Items).withCursor(async (cursor) => {
        await cursor.fetch(1)
      }),
    )
    .catch((error: unknown) => error)

  expect(operationPrimaryFailure(rejection)).toBe(primary)
  expect(operationCleanupFailures(rejection)).toHaveLength(1)
  expect(operationCleanupFailures(rejection)[0]?.cause).toBe(cleanup)

  expect(controls.calls.filter((call) => call.sql.startsWith('CLOSE'))).toHaveLength(1)
  expect(controls.events).toContain('release-finished:1:discard')
  await db.close()
})

it('should reject successful callbacks that catch a close failure', async () => {
  let caught: unknown
  const cleanup = new Error('caught close')
  const { db, controls } = fixture({
    beforeCall: async (_, sql) => {
      if (sql.startsWith('CLOSE')) throw cleanup
    },
  })

  await expect(
    db.transaction(async (tx) => {
      await tx
        .from(Items)
        .withCursor(async (cursor) => {
          caught = await cursor.close().catch((error: unknown) => error)
        })
        .catch(() => undefined)
    }),
  ).rejects.toBe(cleanup)

  expect(caught).toBe(cleanup)
  expect(controls.calls.some((call) => call.sql === 'commit')).toBe(false)
  expect(controls.events).toContain('release-finished:1:discard')
  await db.close()
})

async function rejectLoopBody(primary: unknown): Promise<void> {
  throw primary
}
