import type { Statement } from 'db0'
import { describe, expect, it } from 'vitest'

import {
  POSTGRES_OPERATION_IDENTITY_SQL,
  POSTGRES_OPERATION_ROLLBACK_SQL,
  POSTGRES_OPERATION_UNLOCK_SQL,
} from '@/dialects/postgres/operationSession'
import { scanPostgresSql } from '@/dialects/postgres/postgresSql'
import { createDb0PostgresqlOperationSessionProvider } from '@/index'

import { createNativePostgresClient } from './helpers/nativePostgresClient'
import { createNativeConnector } from './helpers/operationSessionFixtures'

describe('PostgreSQL SQL lexical classification', () => {
  it('lexically classifies stateful SQL without matching inert quoted text', async () => {
    const connector = createNativeConnector()
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const warm = await provider.open()
    await warm.release('reuse')

    /**
     * Simulates statement execution with the fixture's configured outcomes.
     *
     * @param sql - Native SQL text being scanned, compiled, or observed.
     *
     * @returns The run observations in their required order.
     */
    const run = async (sql: string) => {
      const offset = connector.queryCalls.length
      const session = await provider.open()
      await session.run({ sql, params: [] })
      await session.release('reuse')
      return connector.queryCalls.slice(offset)
    }

    await assertStatelessSqlAvoidsCleanup(run)

    for (const sql of [
      '/* trace */ begin',
      'select 1; begin',
      'END',
      'ABORT',
      'select pg_advisory_lock /* trace */ (1)',
      'select "pg_advisory_lock"(1)',
      'select "pg_catalog"."pg_advisory_lock"(1)',
      'select "pg""_catalog"."pg_advisory_lock" /* trace */ (1)',
      `select 'unterminated`,
      'select $body$ unterminated',
      'select 1 /* unterminated',
      'mystery command',
    ]) {
      expect(await run(sql)).toEqual([
        { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
        { text: sql, values: [] },
        { text: POSTGRES_OPERATION_ROLLBACK_SQL, values: [] },
        { text: POSTGRES_OPERATION_UNLOCK_SQL, values: [] },
        { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      ])
    }

    await provider.close()
  })
})

describe('PostgreSQL SQL lexical classification: rewrites only executable PostgreSQL parameters in the test adapter', () => {
  it('rewrites only executable PostgreSQL parameters in the test adapter', async () => {
    const prepared: string[] = []
    const binds: unknown[][] = []
    const statement: Statement = {
      /** Binds fixture parameter values and returns the statement for execution. */
      bind(...params) {
        binds.push(params)
        return statement
      },
      /** Returns the fixture statement rows or its configured rejection. */
      async all() {
        return []
      },
      /** Runs a fixture statement with configured outcomes. */
      async run() {
        return { success: true }
      },
      /** Returns the first fixture row, or undefined when no rows exist. */
      async get() {
        return undefined
      },
    }

    const client = createNativePostgresClient((sql) => {
      prepared.push(sql)
      return statement
    })

    const sql =
      `alter table test alter column value set default '$1';\n` +
      `select "$2", $body$ $3 $body$, /* $4 */ $2, -- $5\n$1, $2`

    await client.query({
      text: sql,
      values: ['first', 'second'],
    })

    expect(prepared).toEqual([
      `alter table test alter column value set default '$1';\n` +
        `select "$2", $body$ $3 $body$, /* $4 */ ?, -- $5\n?, ?`,
    ])

    expect(binds).toEqual([['second', 'first', 'second']])
  })
})

describe('PostgreSQL SQL lexical classification: rewrites only executable PostgreSQL parameters in the test adapter: distinguishes standard strings from PostgreSQL escape strings', () => {
  it('distinguishes standard strings from PostgreSQL escape strings', () => {
    const standard = scanPostgresSql(String.raw`select 'a\' || $1`)
    const escaped = scanPostgresSql(String.raw`select E'a\'' || $1`)

    expect(standard.malformed).toBe(false)
    expect(standard.parameters.map((parameter) => parameter.index)).toEqual([0])
    expect(escaped.malformed).toBe(false)
    expect(escaped.parameters.map((parameter) => parameter.index)).toEqual([0])
  })
})

describe('PostgreSQL SQL lexical classification: rewrites only executable PostgreSQL parameters in the test adapter: uses row execution for commented and parenthesized result queries', () => {
  it('uses row execution for commented and parenthesized result queries', async () => {
    let allCalls = 0
    let runCalls = 0
    const statement: Statement = {
      /** Binds fixture parameter values and returns the statement for execution. */
      bind() {
        return statement
      },
      /** Returns the fixture statement rows or its configured rejection. */
      async all() {
        allCalls++
        return []
      },
      /** Runs a fixture statement with configured outcomes. */
      async run() {
        runCalls++
        return { success: true }
      },
      /** Returns the first fixture row, or undefined when no rows exist. */
      async get() {
        return undefined
      },
    }

    const client = createNativePostgresClient(() => statement)

    for (const sql of [
      '/* trace */ select 1',
      '-- trace\nselect 1',
      '((select 1))',
      'with value as (select 1) select * from value',
      'insert into test default values returning id',
    ]) {
      await client.query({ text: sql, values: [] })
    }

    await client.query({ text: 'update test set value = 1', values: [] })

    expect(allCalls).toBe(5)
    expect(runCalls).toBe(1)
  })
})

/**
 * Checks stateless sql avoids cleanup in the current test scenario.
 *
 * @param run - Scenario callback executed with the fixture's isolated client.
 */
async function assertStatelessSqlAvoidsCleanup(
  run: (sql: string) => Promise<{ text: string; values: unknown[] }[]>,
) {
  for (const sql of [
    `select 'begin; pg_advisory_lock(1)' as value`,
    `select 1 as "abort", '?' as "begin"`,
    `select $body$ begin; pg_advisory_lock(1) $body$ as body`,
    `select 1 /* begin /* rollback */ end */`,
    `select 1 -- begin\n`,
    `select 1 as pg_advisory_lock`,
    `select "PG_ADVISORY_LOCK"(1)`,
    `select "pg_advisory_""lock"(1)`,
    `select "pg_catalog"."not_advisory"(1)`,
    'merge into target using source on false when not matched then insert default values',
    'table users',
  ]) {
    expect(await run(sql)).toEqual([
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      { text: sql, values: [] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])
  }
}
