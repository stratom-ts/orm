import type { Client } from 'pg'
import {
  date,
  isoDate,
  isoDateTime,
  isoDateTimeSecond,
  isoTime,
  isoTimeSecond,
  isoTimestamp,
  pipe,
  safeParse,
  string,
  toDate,
  transform,
} from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { column, defineTable, reference } from '@/index'

import { waitForPostgres } from './postgres.setup'
import { quoteIdentifier, withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const PostgresTemporal = defineTable(
  'native_temporal',
  {
    id: pipe(string(), isoDate()),
    minuteTime: pipe(string(), isoTime()),
    secondTime: pipe(string(), isoTimeSecond()),
    minuteLocal: pipe(string(), isoDateTime()),
    secondLocal: pipe(string(), isoDateTimeSecond()),
    instant: pipe(string(), isoTimestamp()),
    dateValue: date(),
    convertedDate: pipe(string(), isoTimestamp(), toDate()),
  },
  { primaryKey: 'id' },
)

it('should expose native temporal types and preserve microseconds in a non-UTC session', async () => {
  await withPostgresDatabase(
    [PostgresTemporal],
    async ({ db, admin, connector, schema }) => {
      const native = await connector.getInstance!()
      await native.query("set time zone 'Australia/Hobart'")
      await db.migrate().execute()
      await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

      const columns = await admin.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
       where table_schema = $1 and table_name = 'native_temporal'`,
        [schema],
      )

      expect(
        Object.fromEntries(columns.rows.map((row) => [row.column_name, row.data_type])),
      ).toMatchObject({
        id: 'date',
        minuteTime: 'time without time zone',
        secondTime: 'time without time zone',
        minuteLocal: 'timestamp without time zone',
        secondLocal: 'timestamp without time zone',
        instant: 'timestamp with time zone',
        dateValue: 'timestamp with time zone',
        convertedDate: 'timestamp with time zone',
      })

      const row = await db
        .insert(PostgresTemporal)
        .values({
          id: '0042-01-02',
          minuteTime: '03:04',
          secondTime: '03:04:05',
          minuteLocal: '2026-01-02T03:04',
          secondLocal: '2026-01-02T03:04:05',
          instant: '2026-01-02T03:04:05.123456Z',
          dateValue: new Date('2026-01-02T03:04:05.123Z'),
          convertedDate: '2026-01-02T03:04:05.123Z',
        })
        .executeTakeFirstOrThrow()

      expect(row.id).toBe('0042-01-02')
      expect(row.minuteTime).toBe('03:04')
      expect(row.secondTime).toBe('03:04:05')
      expect(row.minuteLocal).toBe('2026-01-02T03:04')
      expect(row.secondLocal).toBe('2026-01-02T03:04:05')
      expect(row.instant).toBe('2026-01-02T14:04:05.123456+11:00')
      expect(safeParse(pipe(string(), isoTimestamp()), row.instant).success).toBe(true)
      expect(row.dateValue).toEqual(new Date('2026-01-02T03:04:05.123Z'))
      expect(row.convertedDate).toEqual(new Date('2026-01-02T03:04:05.123Z'))
    },
  )
})

it('should preserve a year-42 instant across a historical second-resolution offset', async () => {
  await withPostgresDatabase([PostgresTemporal], async ({ db, connector }) => {
    const native = await connector.getInstance!()
    await native.query("set time zone 'Australia/Hobart'")
    await db.migrate().execute()

    const historical = await db
      .insert(PostgresTemporal)
      .values({
        id: '0042-01-03',
        minuteTime: '03:04',
        secondTime: '03:04:05',
        minuteLocal: '0042-01-02T03:04',
        secondLocal: '0042-01-02T03:04:05',
        instant: '0042-01-02T03:04:05.123456Z',
        dateValue: new Date('0042-01-02T03:04:05.123Z'),
        convertedDate: '0042-01-02T03:04:05.123Z',
      })
      .executeTakeFirstOrThrow()

    expect(historical.instant).toBe('0042-01-02T03:04:05.123456Z')
    expect(historical.dateValue).toEqual(new Date('0042-01-02T03:04:05.123Z'))
    expect(historical.convertedDate).toEqual(new Date('0042-01-02T03:04:05.123Z'))
  })
})

const Parent = defineTable(
  'temporal_parent',
  {
    time: pipe(string(), isoTime()),
    local: pipe(string(), isoDateTime(), column({ unique: true })),
  },
  { primaryKey: 'time' },
)

const Child = defineTable(
  'temporal_child',
  {
    time: pipe(
      reference(Parent, 'time'),
      transform((value) => `${value}:00`),
      string(),
      isoTimeSecond(),
    ),
    local: pipe(
      reference(Parent, 'local'),
      transform((value) => `${value}:00`),
      string(),
      isoDateTimeSecond(),
    ),
  },
  { primaryKey: 'time' },
)

it('should preserve authored temporal reference precision with native foreign keys and convergent migrations', async () => {
  await withPostgresDatabase(
    [Child, Parent],
    async ({ db, admin, connector, schema }) => {
      const native = await connector.getInstance!()
      await native.query("set time zone 'Australia/Hobart'")
      await db.migrate().execute()
      await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
      const input = { time: '03:04', local: '2026-01-02T03:04' }
      const output = { time: '03:04:00', local: '2026-01-02T03:04:00' }

      expect(
        await db
          .insert(Parent)
          .values(input)
          .returning([Parent.time, Parent.local])
          .executeTakeFirstOrThrow(),
      ).toEqual(input)

      expect(
        await db
          .insert(Child)
          .values(input)
          .returning([Child.time, Child.local])
          .executeTakeFirstOrThrow(),
      ).toEqual(output)

      expect(await db.from(Parent).execute()).toEqual([input])
      expect(await db.from(Child).execute()).toEqual([output])
      await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

      await assertTemporalReferenceStorage(admin, schema)
      await assertTemporalReferenceTargets(admin, schema)
    },
  )
})

/** Checks native temporal types and stored values independently of result mapping. */
async function assertTemporalReferenceStorage(admin: Client, schema: string) {
  const types = await admin.query<{
    table_name: string
    column_name: string
    data_type: string
  }>(
    `select table_name, column_name, data_type from information_schema.columns
   where table_schema = $1 and table_name in ('temporal_parent', 'temporal_child')`,
    [schema],
  )

  for (const table of ['temporal_parent', 'temporal_child']) {
    expect(types.rows).toContainEqual({
      table_name: table,
      column_name: 'time',
      data_type: 'time without time zone',
    })

    expect(types.rows).toContainEqual({
      table_name: table,
      column_name: 'local',
      data_type: 'timestamp without time zone',
    })

    const stored = await admin.query(
      `select "time"::text, "local"::text from ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
    )

    expect(stored.rows).toEqual([{ time: '03:04:00', local: '2026-01-02 03:04:00' }])
  }
}

/** Checks the actual referenced tables and columns independently of schema metadata. */
async function assertTemporalReferenceTargets(admin: Client, schema: string) {
  const foreignKeys = await admin.query<{
    column_name: string
    foreign_table_name: string
    foreign_column_name: string
  }>(
    `select kcu.column_name, ccu.table_name as foreign_table_name, ccu.column_name as foreign_column_name
   from information_schema.table_constraints tc
   join information_schema.key_column_usage kcu using (constraint_catalog, constraint_schema, constraint_name)
   join information_schema.constraint_column_usage ccu using (constraint_catalog, constraint_schema, constraint_name)
   where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = $1 and tc.table_name = 'temporal_child' order by kcu.column_name`,
    [schema],
  )

  expect(foreignKeys.rows).toEqual([
    {
      column_name: 'local',
      foreign_table_name: 'temporal_parent',
      foreign_column_name: 'local',
    },
    {
      column_name: 'time',
      foreign_table_name: 'temporal_parent',
      foreign_column_name: 'time',
    },
  ])
}
