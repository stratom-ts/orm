import {
  bigint,
  boolean,
  date,
  integer,
  literal,
  nullable,
  number,
  object,
  picklist,
  pipe,
  string,
  transform,
} from 'valibot'
import { expect, it, vi } from 'vitest'

import { column, defineTable, reference } from '@/index'
import { QueryError } from '@/utils/error'

import { withSqliteDatabase } from './sqliteIntegration'

it.each(['INTEGER', 'NUMERIC', 'REAL', 'BLOB', 'FLOATING POINT', 'DECIMAL(10,2)'])(
  'should preserve logical numbers and booleans through %s affinity, predicates and RETURNING',
  async (type) => {
    const Records = defineTable(
      'records',
      {
        id: pipe(number(), integer()),
        value: pipe(nullable(number()), column({ physicalType: { sqlite: type } })),
        active: pipe(nullable(boolean()), column({ physicalType: { sqlite: type } })),
      },
      { primaryKey: 'id' },
    )

    await withSqliteDatabase([Records], async ({ db, native }) => {
      await db.migrate().execute()
      const row = { id: 1, value: 1.5, active: false }
      expect(await db.insert(Records).values(row).execute()).toEqual([row])

      expect(
        await db.from(Records).where({ value: 1.5, active: false }).execute(),
      ).toEqual([row])

      expect(
        await db
          .update(Records)
          .set({ value: Number.MAX_SAFE_INTEGER, active: true })
          .where({ active: false })
          .execute(),
      ).toEqual([{ id: 1, value: Number.MAX_SAFE_INTEGER, active: true }])

      expect(
        await db
          .delete(Records)
          .where({ active: true, value: Number.MAX_SAFE_INTEGER })
          .execute(),
      ).toEqual([{ id: 1, value: Number.MAX_SAFE_INTEGER, active: true }])

      const empty = { id: 2, value: null, active: null }
      expect(await db.insert(Records).values(empty).execute()).toEqual([empty])
      expect(await db.from(Records).where({ id: 2 }).execute()).toEqual([empty])

      await expect(
        db
          .insert(Records)
          .values({ id: 3, value: Number.MAX_SAFE_INTEGER + 1, active: false })
          .execute(),
      ).rejects.toThrow(QueryError)

      expect(native.prepare('select id from records order by id').all()).toEqual([
        { id: 2 },
      ])
    })
  },
)

it.each(['TEXT', 'CHARACTER VARYING(32)', 'BLOB'])(
  'should preserve string spelling through %s in SELECT, RETURNING and predicates',
  async (type) => {
    const Records = defineTable(
      'records',
      {
        value: pipe(string(), column({ physicalType: { sqlite: type } })),
      },
      { primaryKey: 'value' },
    )

    await withSqliteDatabase([Records], async ({ db }) => {
      await db.migrate().execute()

      expect(
        await db
          .insert(Records)
          .values([{ value: '00123' }, { value: '123' }])
          .execute(),
      ).toEqual([{ value: '00123' }, { value: '123' }])

      expect(await db.from(Records).where({ value: '00123' }).execute()).toEqual([
        { value: '00123' },
      ])

      expect(
        await db
          .update(Records)
          .set({ value: '00456' })
          .where({ value: '00123' })
          .execute(),
      ).toEqual([{ value: '00456' }])

      expect(await db.from(Records).where({ value: '00456' }).execute()).toEqual([
        { value: '00456' },
      ])
    })
  },
)

it.each(['INTEGER', 'NUMERIC', 'BLOB'])(
  'should enforce signed 64-bit bigint values through %s before native execution',
  async (type) => {
    const Records = defineTable(
      'records',
      {
        value: pipe(bigint(), column({ physicalType: { sqlite: type } })),
      },
      { primaryKey: 'value' },
    )

    await withSqliteDatabase([Records], async ({ db, native }) => {
      await db.migrate().execute()
      const rows = [
        { value: -9223372036854775808n },
        { value: 9007199254740993n },
        { value: 9223372036854775807n },
      ]

      expect(await db.insert(Records).values(rows).execute()).toEqual(rows)
      expect(await db.from(Records).orderBy(Records.value, 'asc').execute()).toEqual(rows)

      const prepare = vi.spyOn(native, 'prepare')

      await expect(
        db.insert(Records).values({ value: 9223372036854775808n }).execute(),
      ).rejects.toThrow(/signed 64-bit integer range/)

      await expect(
        db.from(Records).where({ value: -9223372036854775809n }).execute(),
      ).rejects.toThrow(/signed 64-bit integer range/)

      expect(prepare).not.toHaveBeenCalled()
      prepare.mockRestore()
      expect(await db.from(Records).orderBy(Records.value, 'asc').execute()).toEqual(rows)

      expect(
        await db
          .update(Records)
          .set({ value: 42n })
          .where({ value: 9007199254740993n })
          .execute(),
      ).toEqual([{ value: 42n }])

      expect(await db.from(Records).where({ value: 42n }).execute()).toEqual([
        { value: 42n },
      ])
    })
  },
)

it('should reject an out-of-range native bigint result', async () => {
  const Records = defineTable(
    'records',
    {
      value: pipe(bigint(), column({ physicalType: { sqlite: 'BLOB' } })),
    },
    { primaryKey: 'value' },
  )

  await withSqliteDatabase([Records], async ({ db, native }) => {
    native.exec(
      "create table records(value BLOB); insert into records values('9223372036854775808')",
    )

    await expect(db.from(Records).execute()).rejects.toThrow(
      /signed 64-bit integer range/,
    )
  })
})

it('should let paired column hooks own bigint values outside the built-in range', async () => {
  const Records = defineTable(
    'records',
    {
      value: pipe(
        bigint(),
        column({
          physicalType: { sqlite: 'BLOB' },
          mapParam: String,
          mapResult: (value) => BigInt(String(value)),
        }),
      ),
    },
    { primaryKey: 'value' },
  )

  await withSqliteDatabase([Records], async ({ db }) => {
    const row = { value: 9223372036854775808n }

    await db.migrate().execute()
    expect(await db.insert(Records).values(row).execute()).toEqual([row])
    expect(await db.from(Records).where(row).execute()).toEqual([row])
  })
})

it.each(['column', 'client', 'mixed'])(
  'should use paired %s hooks for safe numeric/boolean TEXT and numeric-affinity strings',
  async (scope) => {
    const encode = (value: unknown) => JSON.stringify({ value })
    const decode = (value: unknown) =>
      (JSON.parse(String(value)) as { value: unknown }).value

    const hooks = {
      ...(scope !== 'client' ? { mapParam: encode } : {}),
      ...(scope === 'column' ? { mapResult: decode } : {}),
    }

    const Records = defineTable(
      'records',
      {
        value: pipe(number(), column({ physicalType: { sqlite: 'TEXT' }, ...hooks })),
        active: pipe(boolean(), column({ physicalType: { sqlite: 'TEXT' }, ...hooks })),
        label: pipe(string(), column({ physicalType: { sqlite: 'INTEGER' }, ...hooks })),
      },
      { primaryKey: 'value' },
    )

    await withSqliteDatabase(
      [Records],
      async ({ db }) => {
        await db.migrate().execute()
        const row = { value: 1.5, active: false, label: '00123' }
        expect(await db.insert(Records).values(row).execute()).toEqual([row])
        expect(await db.from(Records).where(row).execute()).toEqual([row])
      },
      {
        map:
          scope === 'column'
            ? undefined
            : {
                ...(scope === 'client'
                  ? { mapParamValue: (_type, value) => encode(value) }
                  : {}),
                mapResultValue: (_type, value) => decode(value),
              },
      },
    )
  },
)

it('should reject unsafe native integer results for logical numbers', async () => {
  const Records = defineTable(
    'records',
    { value: pipe(number(), column({ physicalType: { sqlite: 'INTEGER' } })) },
    { primaryKey: 'value' },
  )

  await withSqliteDatabase([Records], async ({ db, native }) => {
    native.exec(
      'create table records(value INTEGER); insert into records values(9007199254740993)',
    )

    await expect(db.from(Records).execute()).rejects.toThrow(QueryError)
  })
})

it('should keep compatible built-in mappings when only one column direction is overridden', async () => {
  const Records = defineTable(
    'records',
    {
      id: pipe(number(), integer()),
      encoded: pipe(
        boolean(),
        column({
          physicalType: { sqlite: 'INTEGER' },
          mapParam: (value) => (value ? 1 : 0),
        }),
      ),
      decoded: pipe(
        boolean(),
        column({
          physicalType: { sqlite: 'INTEGER' },
          mapResult: (value) => value === 1,
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Records], async ({ db }) => {
    await db.migrate().execute()
    const row = { id: 1, encoded: false, decoded: false }
    expect(await db.insert(Records).values(row).execute()).toEqual([row])

    expect(
      await db.from(Records).where({ encoded: false, decoded: false }).execute(),
    ).toEqual([row])
  })
})

it('should map transformed references through paired hooks in SELECT and predicates', async () => {
  const Parents = defineTable('parents', { value: string() }, { primaryKey: 'value' })
  const Children = defineTable(
    'children',
    {
      id: pipe(number(), integer()),
      value: pipe(
        reference(Parents, 'value'),
        transform(Number),
        column({
          physicalType: { sqlite: 'TEXT' },
          mapParam: String,
          mapResult: Number,
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Parents, Children], async ({ db, native }) => {
    await db.migrate().execute()
    await db.insert(Parents).values({ value: '123' }).execute()
    native.exec("insert into children(id,value) values(1,'123')")

    expect(await db.from(Children).execute()).toEqual([{ id: 1, value: 123 }])

    expect(await db.from(Children).where({ value: 123 }).execute()).toEqual([
      { id: 1, value: 123 },
    ])
  })
})

it('should retain Date and bracketed JSON values with numeric affinity', async () => {
  const Records = defineTable(
    'records',
    {
      stamp: pipe(date(), column({ physicalType: { sqlite: 'INTEGER' } })),
      data: pipe(
        object({ label: string() }),
        column({ physicalType: { sqlite: 'NUMERIC' } }),
      ),
      choice: pipe(picklist([1, 2]), column({ physicalType: { sqlite: 'INTEGER' } })),
      fixed: pipe(literal(false), column({ physicalType: { sqlite: 'REAL' } })),
    },
    { primaryKey: 'choice' },
  )

  await withSqliteDatabase([Records], async ({ db }) => {
    await db.migrate().execute()
    const row = {
      stamp: new Date('2026-01-02T03:04:05.000Z'),
      data: { label: '00123' },
      choice: 1 as const,
      fixed: false as const,
    }

    expect(await db.insert(Records).values(row).execute()).toEqual([row])
    expect(await db.from(Records).execute()).toEqual([row])

    expect(
      await db.from(Records).where({ stamp: row.stamp, data: row.data }).execute(),
    ).toEqual([row])

    const changed = {
      ...row,
      stamp: new Date('2026-01-03T03:04:05.000Z'),
      data: { label: 'next' },
    }

    expect(await db.update(Records).set(changed).where({ choice: 1 }).execute()).toEqual([
      changed,
    ])

    expect(
      await db
        .from(Records)
        .where({ stamp: changed.stamp, data: changed.data })
        .execute(),
    ).toEqual([changed])
  })
})
