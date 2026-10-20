import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'

import { withSqliteDatabase } from './sqliteIntegration'

it('should return the callback value and close a native-only in-memory connection', async () => {
  const { native, value } = await withSqliteDatabase(
    [],
    async ({ native, nativeSql }) => {
      await nativeSql('create table fixture (id integer primary key)')
      native.exec('insert into fixture (id) values (7)')
      return { native, value: native.prepare('select id from fixture').get() }
    },
  )

  expect(value).toEqual({ id: 7 })
  expect(() => native.prepare('select 1')).toThrow(/not open/)
})

it.each([new Error('callback failed'), undefined])(
  'should close the connection and preserve callback rejection %s',
  async (primary) => {
    let native: DatabaseSync | undefined

    await expect(
      withSqliteDatabase([], async (context) => {
        native = context.native
        throw primary
      }),
    ).rejects.toBe(primary)

    expect(() => native!.prepare('select 1')).toThrow(/not open/)
  },
)

it('should isolate file databases and remove each owned directory', async () => {
  const first = await withSqliteDatabase(
    [],
    async ({ native, filePath }) => {
      native.exec('create table fixture (id integer primary key)')
      expect(filePath && existsSync(filePath)).toBe(true)

      const second = await withSqliteDatabase(
        [],
        async ({ native: other, filePath: otherPath }) => {
          expect(otherPath).not.toBe(filePath)
          other.exec('create table fixture (id integer primary key)')
          return { native: other, filePath: otherPath }
        },
        { file: true },
      )

      expect(() => second.native.prepare('select 1')).toThrow(/not open/)
      expect(second.filePath && existsSync(second.filePath)).toBe(false)
      expect(second.filePath && existsSync(dirname(second.filePath))).toBe(false)
      native.exec('insert into fixture (id) values (1)')
      return { native, filePath }
    },
    { file: true },
  )

  expect(() => first.native.prepare('select 1')).toThrow(/not open/)
  expect(first.filePath && existsSync(first.filePath)).toBe(false)
  expect(first.filePath && existsSync(dirname(first.filePath))).toBe(false)
})

it('should keep callback and cleanup failures while closing and removing a file database', async () => {
  const primary = new Error('callback failed')
  const cleanup = new Error('additional cleanup failed')
  let native: DatabaseSync | undefined
  let filePath: string | undefined

  const failure = await withSqliteDatabase(
    [],
    async (context) => {
      native = context.native
      filePath = context.filePath
      throw primary
    },
    {
      file: true,
      async additionalCleanup() {
        throw cleanup
      },
    },
  ).catch((cause: unknown) => cause)

  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors[0]).toBe(primary)
  expect((failure as AggregateError).errors[1]).toBe(cleanup)
  expect(() => native!.prepare('select 1')).toThrow(/not open/)
  expect(filePath && existsSync(filePath)).toBe(false)
  expect(filePath && existsSync(dirname(filePath))).toBe(false)
})

it('should report cleanup-only failure after closing the native connection', async () => {
  const cleanup = new Error('additional cleanup failed')
  let native: DatabaseSync | undefined

  const failure = await withSqliteDatabase(
    [],
    async (context) => {
      native = context.native
    },
    {
      async additionalCleanup() {
        throw cleanup
      },
    },
  ).catch((cause: unknown) => cause)

  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([cleanup])
  expect(() => native!.prepare('select 1')).toThrow(/not open/)
})
