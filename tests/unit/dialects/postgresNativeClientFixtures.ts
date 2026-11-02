import type { Connector, Statement } from 'db0'

import {
  POSTGRES_OPERATION_IDENTITY_SQL,
  POSTGRES_OPERATION_ROLLBACK_SQL,
  POSTGRES_OPERATION_UNLOCK_SQL,
} from '@/dialects/postgres/operationSession'
import { scanPostgresSql } from '@/dialects/postgres/sqlScan'

type NativeQuery =
  | string
  | {
      text: string
      values: unknown[]
      signal?: AbortSignal
    }

let nextProcessId = 10_000

/**
 * Skips leading comments and wrappers before classifying the executable SQL statement.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 *
 * @returns The SQL suffix after leading whitespace, comments, and opening parentheses.
 */
function normalizeQueryStart(sql: string): string {
  let offset = 0

  while (offset < sql.length) {
    while (/\s/.test(sql[offset] ?? '')) offset++

    const commentEnd = sql.startsWith('/*', offset) ? sql.indexOf('*/', offset + 2) : null

    if (commentEnd === -1) return sql.slice(offset)

    if (sql.startsWith('--', offset)) {
      const newline = sql.indexOf('\n', offset + 2)
      offset = newline === -1 ? sql.length : newline + 1
      continue
    }

    if (commentEnd !== null) {
      offset = commentEnd + 2
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

/**
 * Creates a native-client fixture with stable backend identity and db0 statement
 * execution.
 *
 * @param prepare - Callback that supplies a db0 statement for native SQL execution.
 * @param database - Native database identity or spelling used to scope fixture resources.
 * @param currentSchema - Callback reporting the native client's current writable schema.
 *
 * @returns A native-client fixture with stable backend identity and db0 statement
 *   execution.
 */
function createNativePostgresClient(
  prepare: (sql: string) => Statement,
  database = 'test',
  currentSchema = 'public',
) {
  const processID = nextProcessId++
  return {
    processID,
    database,
    readyForQuery: true,
    activeQuery: null,
    queryQueue: [],
    /** Supplies the native parser for types without a query override. */
    getTypeParser: (_oid: number, _format?: string) => (value: string) => value,
    /** Closes the native PostgreSQL client and its physical connection. */
    async end() {},
    /** Runs fixture SQL and records physical-session ownership. */
    query: (query: NativeQuery, values: unknown[] = []) =>
      executeMockNativeQuery(query, values, processID, database, currentSchema, prepare),
  }
}

/**
 * Creates a reusable db0 statement fixture with deterministic rows and optional execution
 * failure.
 *
 * @param rows - Ordered native observations or result rows to process.
 *
 * @returns A reusable db0 statement fixture with deterministic rows and optional
 *   execution failure.
 */
function createMockStatement(rows: unknown[] = []): Statement {
  const statement: Statement = {
    /** Binds fixture parameter values and returns the statement for execution. */
    bind() {
      return statement
    },
    /** Returns the fixture statement rows or its configured rejection. */
    async all() {
      return rows
    },
    /** Runs a fixture statement with configured outcomes. */
    async run() {
      return { success: true }
    },
    /** Returns the first fixture row, or undefined when no rows exist. */
    async get() {
      return rows[0]
    },
  }

  return statement
}

/**
 * Creates a native PostgreSQL connector fixture with recorded SQL, bindings, and disposal
 * state.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A native PostgreSQL connector fixture with recorded SQL, bindings, and
 *   disposal state.
 */
function createMockPostgresConnector(options?: {
  onPrepare?: (sql: string) => Statement
  rowsBySql?: (sql: string) => unknown[]
  database?: string
  currentSchema?: string
}): Connector & {
  disposed: boolean
  prepared: string[]
  binds: unknown[][]
} {
  const prepared: string[] = []
  const binds: unknown[][] = []

  /**
   * Creates the fixture statement associated with the supplied SQL.
   *
   * @param sql - Native SQL text being scanned, compiled, or observed.
   *
   * @returns The fixture statement associated with the supplied SQL.
   */
  const prepare = (sql: string) => prepareRecordedStatement(sql, prepared, binds, options)

  const nativeClient = createNativePostgresClient(
    prepare,
    options?.database,
    options?.currentSchema,
  )

  const connector = {
    name: 'postgresql',
    dialect: 'postgresql' as const,
    disposed: false,
    prepared,
    binds,
    /** Returns the native client owned by the fixture connector. */
    getInstance: () => nativeClient,
    /** Executes connector SQL for the fixture scenario. */
    exec: async () => ({}),
    prepare,
    /** Records disposal and closes owned fixture resources. */
    dispose: async () => {
      connector.disposed = true
    },
  }

  return connector
}

/**
 * Translates native query calls into fixture statements while preserving parameters and
 * cleanup commands.
 *
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param values - Ordered values supplied for SQL parameter binding.
 * @param processID - Native backend identifier used as physical-session evidence.
 * @param database - Native database identity or spelling used to scope fixture resources.
 * @param currentSchema - Callback reporting the native client's current writable schema.
 * @param prepare - Callback that supplies a db0 statement for native SQL execution.
 *
 * @returns Native identity rows or the configured statement's result rows.
 */
async function executeMockNativeQuery(
  query: NativeQuery,
  values: unknown[] = [],
  processID: number,
  database: string,
  currentSchema: string,
  prepare: (sql: string) => Statement,
) {
  const text = typeof query === 'string' ? query : query.text
  const params = typeof query === 'string' ? values : query.values
  const signal = typeof query === 'string' ? undefined : query.signal

  if (signal?.aborted) throw new Error('Query cancelled')

  if (text === POSTGRES_OPERATION_IDENTITY_SQL) {
    return {
      rows: [{ physicalSession: String(processID), database, schema: currentSchema }],
    }
  }

  if (
    text === POSTGRES_OPERATION_ROLLBACK_SQL ||
    text === POSTGRES_OPERATION_UNLOCK_SQL
  ) {
    return { rows: [] }
  }

  const bound = prepareMockNativeStatement(text, params, prepare)

  if (/^(?:select|with)\b|\breturning\b/i.test(normalizeQueryStart(text))) {
    return { rows: await bound.all() }
  }

  await bound.run()
  return { rows: [] }
}

/**
 * Reorders PostgreSQL placeholders and binds their values to a db0 statement fixture.
 *
 * @param text - Native SQL text observed by the session fixture.
 * @param params - Mutable bound-value list extended in emitted SQL order.
 * @param prepare - Callback that supplies a db0 statement for native SQL execution.
 *
 * @returns The db0 statement bound in PostgreSQL placeholder occurrence order.
 */
function prepareMockNativeStatement(
  text: string,
  params: unknown[],
  prepare: (sql: string) => Statement,
) {
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
    orderedParams.length === 0 ? statement : statement.bind(...(orderedParams as never[]))

  return bound
}

/**
 * Records prepared SQL and bindings while delegating native statement results.
 *
 * @param sql - Native fixture SQL.
 * @param prepared - SQL observations in call order.
 * @param binds - Parameter observations in binding order.
 * @param options - Optional statement and row overrides.
 *
 * @returns A statement wrapper preserving the configured native results.
 */
function prepareRecordedStatement(
  sql: string,
  prepared: string[],
  binds: unknown[][],
  options: Parameters<typeof createMockPostgresConnector>[0],
): Statement {
  prepared.push(sql)
  const base =
    options?.onPrepare?.(sql) ?? createMockStatement(options?.rowsBySql?.(sql) ?? [])

  return {
    /** Binds fixture parameter values and returns the statement for execution. */
    bind(...params: unknown[]) {
      binds.push(params)
      return base.bind(...(params as never[]))
    },
    /** Returns the fixture statement rows or its configured rejection. */
    all: () => base.all(),
    /** Runs a fixture statement with configured outcomes. */
    run: () => base.run(),
    /** Returns the first fixture row, or undefined when no rows exist. */
    get: () => base.get(),
  }
}

export { createNativePostgresClient, createMockStatement, createMockPostgresConnector }
