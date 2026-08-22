import type { Connector, Statement } from 'db0'

import {
  POSTGRES_OPERATION_IDENTITY_SQL,
  POSTGRES_OPERATION_ROLLBACK_SQL,
  POSTGRES_OPERATION_UNLOCK_SQL,
} from '@/dialects/postgres/operationSession'
import { scanPostgresSql } from '@/dialects/postgres/postgresSql'

type NativeQuery =
  | string
  | {
      text: string
      values: unknown[]
      signal?: AbortSignal
    }

let nextProcessId = 10_000

function normalizeQueryStart(sql: string): string {
  let offset = 0

  while (offset < sql.length) {
    while (/\s/.test(sql[offset] ?? '')) offset++

    if (sql.startsWith('--', offset)) {
      const newline = sql.indexOf('\n', offset + 2)
      offset = newline === -1 ? sql.length : newline + 1
      continue
    }

    if (sql.startsWith('/*', offset)) {
      const closing = sql.indexOf('*/', offset + 2)
      if (closing === -1) return sql.slice(offset)
      offset = closing + 2
      continue
    }

    if (sql[offset] === '(') {
      offset++
      continue
    }

    break
  }

  return sql.slice(offset)
}

export function createNativePostgresClient(prepare: (sql: string) => Statement) {
  const processID = nextProcessId++
  return {
    processID,
    database: 'test',
    readyForQuery: true,
    activeQuery: null,
    queryQueue: [],
    async end() {},
    async query(query: NativeQuery, values: unknown[] = []) {
      const text = typeof query === 'string' ? query : query.text
      const params = typeof query === 'string' ? values : query.values
      const signal = typeof query === 'string' ? undefined : query.signal
      if (signal?.aborted) throw new Error('Query cancelled')

      if (text === POSTGRES_OPERATION_IDENTITY_SQL) {
        return {
          rows: [{ physicalSession: String(processID), database: 'test' }],
        }
      }

      if (
        text === POSTGRES_OPERATION_ROLLBACK_SQL ||
        text === POSTGRES_OPERATION_UNLOCK_SQL
      ) {
        return { rows: [] }
      }

      const scan = scanPostgresSql(text)
      let cursor = 0
      let db0Sql = ''

      for (const parameter of scan.parameters) {
        db0Sql += `${text.slice(cursor, parameter.start)}?`
        cursor = parameter.end
      }

      db0Sql += text.slice(cursor)
      const orderedParams =
        scan.parameters.length === 0
          ? params
          : scan.parameters.map((parameter) => params[parameter.index])
      const statement = prepare(db0Sql)
      const bound =
        orderedParams.length === 0
          ? statement
          : statement.bind(...(orderedParams as never[]))

      if (/^(?:select|with)\b|\breturning\b/i.test(normalizeQueryStart(text))) {
        return { rows: await bound.all() }
      }

      await bound.run()
      return { rows: [] }
    },
  }
}

export function createMockStatement(rows: unknown[] = []): Statement {
  const statement: Statement = {
    bind() {
      return statement
    },
    async all() {
      return rows
    },
    async run() {
      return { success: true }
    },
    async get() {
      return rows[0]
    },
  }
  return statement
}

export function createMockPostgresConnector(options?: {
  onPrepare?: (sql: string) => Statement
  rowsBySql?: (sql: string) => unknown[]
}): Connector & {
  disposed: boolean
  prepared: string[]
  binds: unknown[][]
} {
  const prepared: string[] = []
  const binds: unknown[][] = []

  const prepare = (sql: string) => {
    prepared.push(sql)
    const base =
      options?.onPrepare?.(sql) ?? createMockStatement(options?.rowsBySql?.(sql) ?? [])
    return {
      bind(...params: unknown[]) {
        binds.push(params)
        return base.bind(...(params as never[]))
      },
      all: () => base.all(),
      run: () => base.run(),
      get: () => base.get(),
    }
  }

  const nativeClient = createNativePostgresClient(prepare)
  const connector = {
    name: 'postgresql',
    dialect: 'postgresql' as const,
    disposed: false,
    prepared,
    binds,
    getInstance: () => nativeClient,
    exec: async () => ({}),
    prepare,
    dispose: async () => {
      connector.disposed = true
    },
  }
  return connector
}
