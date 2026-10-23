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
} from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { defineTable } from '@/index'

import { waitForPostgres } from './postgres.setup'
import { withPostgresDatabase } from './postgresIntegration'

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
