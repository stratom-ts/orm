import {
  operationCleanupFailures,
  operationPrimaryFailure,
  withOperationCleanupFailure,
} from '@/operations/cleanup'
import { QueryError } from '@/utils/error'

type CursorOptions = Readonly<{ signal?: AbortSignal }>
type BatchOptions = CursorOptions & Readonly<{ batchSize?: number }>

/** A transaction-owned server cursor, valid only inside its callback scope. */
interface Cursor<Row> {
  /** Fetches at most count rows. Count must be a positive safe integer. */
  fetch(count: number): Promise<Row[]>
  /** Releases the server cursor early. Repeated closure is safe. */
  close(): Promise<void>
}

type CursorTerminals<Row> = {
  batches(options?: BatchOptions): AsyncIterableIterator<Row[]>
  withCursor<T>(
    callback: (cursor: Cursor<Row>) => Promise<T>,
    options?: CursorOptions,
  ): Promise<T>
}

function assertFetchCount(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0)
    throw new QueryError({
      message: 'Cursor fetch count must be a positive safe integer',
    })
}

/** Shares scoped cleanup between explicit fetching and lazy batch iteration. */
function cursorTerminals<Row>(
  open: (signal?: AbortSignal) => Promise<Cursor<Row>>,
): CursorTerminals<Row> {
  return {
    async withCursor(callback, options) {
      const cursor = await open(options?.signal)
      let failed = false
      let primary: unknown
      try {
        options?.signal?.throwIfAborted()
        const result = await callback(cursor)
        options?.signal?.throwIfAborted()
        return result
      } catch (error) {
        failed = true
        primary = error
        throw error
      } finally {
        await closeCursor(cursor, failed, primary)
      }
    },
    async *batches(options) {
      const count = options?.batchSize ?? 100
      assertFetchCount(count)
      const cursor = await open(options?.signal)
      let failed = false
      let primary: unknown
      try {
        yield* fetchBatches(cursor, count)
      } catch (error) {
        failed = true
        primary = error
        throw error
      } finally {
        await closeCursor(cursor, failed, primary)
      }
    },
  }
}

async function closeCursor(
  cursor: Cursor<unknown>,
  failed: boolean,
  primary: unknown,
): Promise<void> {
  try {
    await cursor.close()
  } catch (error) {
    throw failed ? withCursorCleanupFailure(primary, error) : error
  }
}

async function* fetchBatches<Row>(
  cursor: Cursor<Row>,
  count: number,
): AsyncIterableIterator<Row[]> {
  while (true) {
    const rows = await cursor.fetch(count)

    if (!rows.length) return

    yield rows
  }
}

/** Repeated closure observes the same physical failure at several ownership boundaries. */
function withCursorCleanupFailure(primary: unknown, cleanup: unknown): unknown {
  if (
    operationPrimaryFailure(primary) === cleanup ||
    operationCleanupFailures(primary).some((failure) => failure.cause === cleanup)
  )
    return primary

  return withOperationCleanupFailure(primary, cleanup)
}

export type { Cursor, CursorOptions, BatchOptions, CursorTerminals }
export { assertFetchCount, cursorTerminals, withCursorCleanupFailure }
