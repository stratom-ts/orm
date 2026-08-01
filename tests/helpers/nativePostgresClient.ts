import type { Statement } from 'db0'

type NativeQuery =
  | string
  | {
      text: string
      values: unknown[]
      signal?: AbortSignal
    }

let nextProcessId = 10_000

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

      if (/pg_backend_pid\(\).*current_database\(\)/is.test(text)) {
        return {
          rows: [{ physicalSession: String(processID), database: 'test' }],
        }
      }
      if (/stratom operation release/i.test(text)) {
        return { rows: [] }
      }

      const db0Sql = text.replace(/\$\d+/g, '?')
      const statement = prepare(db0Sql)
      const bound =
        params.length === 0 ? statement : statement.bind(...(params as never[]))
      if (/^\s*(?:select|with)\b|\breturning\b/i.test(text)) {
        return { rows: await bound.all() }
      }
      await bound.run()
      return { rows: [] }
    },
  }
}
