import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  OperationSession,
  OperationSessionProvider,
} from '@/operations/operationSession'

/** Owns temporary database directories until the suite's cleanup hook runs. */
export function createSqliteFileScope() {
  const directories: string[] = []
  return {
    filePath: () => {
      const directory = mkdtempSync(join(tmpdir(), 'stratom-sqlite-'))
      directories.push(directory)
      return join(directory, 'database.sqlite')
    },
    cleanup: () => {
      for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** Attempts every lease release and provider close, retaining all cleanup failures. */
export async function closeSqliteProviders(
  sessions: readonly OperationSession[],
  providers: readonly OperationSessionProvider[],
): Promise<void> {
  const releases = await Promise.allSettled(
    sessions.map((session) => session.release('discard')),
  )

  const closes = await Promise.allSettled(providers.map((provider) => provider.close()))
  const failures = [...releases, ...closes].flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  )

  if (failures.length)
    throw new AggregateError(failures, 'SQLite provider cleanup failed')
}
