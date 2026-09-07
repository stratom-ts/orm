import { boolean, nullable, number, optional, pipe, string } from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  QueryError,
  SchemaError,
  ValidationError,
  column,
  createDatabase,
  defineTable,
} from '@/index'

import { createMockPostgresConnector as createMockConnector } from '../helpers/nativePostgresClient'

const Users = defineTable(
  'users',
  {
    id: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'byDefault' },
      }),
    ),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    displayName: optional(
      pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: '' },
        }),
      ),
    ),
    active: pipe(
      boolean(),
      column({
        physicalType: { postgresql: 'boolean' },
        databaseDefault: { kind: 'literal', value: true },
      }),
    ),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

const AlwaysId = defineTable(
  'always_id',
  {
    id: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'always' },
      }),
    ),
    label: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id' },
)

const NestedWrappers = defineTable(
  'nested_wrappers',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    optionalNullable: optional(
      nullable(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
    ),
    nullableOptional: nullable(
      optional(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
    ),
  },
  { primaryKey: 'id' },
)

describe('CRUD compile', () => {
  it('should compile insert with parameterized values and schema-qualified table', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .insert(Users)
      .values({ email: 'a@b.com', displayName: 'Ada' })
      .compile()

    expect(compiled.sql.toLowerCase()).toContain('insert into')
    expect(compiled.sql).toContain('"public"')
    expect(compiled.sql).toContain('"users"')
    expect(compiled.sql).toMatch(/\$1/)
    expect(compiled.params).toEqual(expect.arrayContaining(['a@b.com', 'Ada']))
    expect(compiled.sql.toLowerCase()).not.toContain('a@b.com')

    await db.close()
  })

  it('should compile bulk insert', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .insert(Users)
      .values([{ email: 'a@b.com' }, { email: 'b@c.com', displayName: 'Bob' }])
      .compile()

    expect(compiled.sql.toLowerCase()).toContain('values')
    expect(compiled.sql.toLowerCase()).toMatch(/default/)
    expect(compiled.params.filter((p) => typeof p === 'string')).toEqual(
      expect.arrayContaining(['a@b.com', 'b@c.com', 'Bob']),
    )

    await db.close()
  })

  it('should compile update with where and default returning *', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .update(Users)
      .set({ displayName: 'X' })
      .where(Users.email, 'eq', 'a@b.com')
      .compile()

    expect(compiled.sql.toLowerCase()).toContain('update')
    expect(compiled.sql.toLowerCase()).toContain('set')
    expect(compiled.sql.toLowerCase()).toContain('where')
    expect(compiled.sql.toLowerCase()).toContain('returning *')
    expect(compiled.params).toEqual(['X', 'a@b.com'])

    await db.close()
  })

  it('should compile delete with object where and column returning', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .delete(Users)
      .where({ email: 'a@b.com' })
      .returning([Users.id])
      .compile()

    expect(compiled.sql.toLowerCase()).toContain('delete from')
    expect(compiled.sql).toContain('"id"')
    expect(compiled.params).toEqual(['a@b.com'])

    await db.close()
  })

  it('should reject empty returning projections', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.insert(Users).values({ email: 'a@b.com' }).returning([])).toThrow(
      /requires at least one column/,
    )
    expect(() => db.update(Users).set({ active: false }).all().returning([])).toThrow(
      /requires at least one column/,
    )
    expect(() => db.delete(Users).all().returning([])).toThrow(
      /requires at least one column/,
    )

    await db.close()
  })
})

describe('CRUD returning types', () => {
  it('should narrow insert.returning to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db
      .insert(Users)
      .values({ email: 'a@b.com' })
      .returning([Users.id, Users.email])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]

    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
    expectTypeOf<Row>().not.toHaveProperty('displayName')
    expectTypeOf<Row>().not.toHaveProperty('active')
  })

  it('should narrow update.returning to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db
      .update(Users)
      .set({ displayName: 'X' })
      .where(Users.id, 'eq', 1)
      .returning([Users.id])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]

    expectTypeOf<Row>().toEqualTypeOf<{ id: number }>()
  })

  it('should narrow delete.returning to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.delete(Users).where({ id: 1 }).returning([Users.email])
    type Row = Awaited<ReturnType<typeof query.execute>>[number]

    expectTypeOf<Row>().toEqualTypeOf<{ email: string }>()
  })
})

describe('CRUD safety and validation', () => {
  it('should reject update without where unless .all()', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.update(Users).set({ displayName: 'x' }).compile()).toThrow(QueryError)

    expect(() => db.update(Users).set({ displayName: 'x' }).compile()).toThrow(
      /where|\.all\(\)/i,
    )

    const ok = db.update(Users).set({ displayName: 'x' }).all().compile()
    expect(ok.sql.toLowerCase()).toContain('update')
    expect(ok.sql.toLowerCase()).not.toContain('where')

    await db.close()
  })

  it('should reject delete without where unless .all()', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.delete(Users).compile()).toThrow(QueryError)

    const ok = db.delete(Users).all().compile()
    expect(ok.sql.toLowerCase()).toContain('delete from')

    await db.close()
  })

  it('should reject invalid insert with ValidationError before SQL', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() =>
      db
        .insert(Users)
        .values({ email: 123 as never })
        .compile(),
    ).toThrow(ValidationError)

    expect(connector.prepared).toHaveLength(0)

    await db.close()
  })

  it('should reject always-generated columns on insert', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [AlwaysId] })

    expect(() =>
      db
        .insert(AlwaysId)
        .values({ id: 1, label: 'x' } as never)
        .compile(),
    ).toThrow(ValidationError)

    expect(() =>
      db
        .insert(AlwaysId)
        .values({ id: 1, label: 'x' } as never)
        .compile(),
    ).toThrow(/non-insertable|unknown/i)

    const ok = db.insert(AlwaysId).values({ label: 'x' }).compile()
    expect(ok.sql.toLowerCase()).toContain('insert')
    expect(ok.params).toEqual(['x'])

    await db.close()
  })

  it('should require bare nullable columns on insert but accept null', async () => {
    const WithNullable = defineTable(
      'with_nullable',
      {
        id: pipe(
          number(),
          column({
            physicalType: { postgresql: 'integer' },
            generation: { kind: 'identity', mode: 'byDefault' },
          }),
        ),
        note: nullable(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
      },
      { primaryKey: 'id' },
    )

    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [WithNullable] })

    expect(() =>
      db
        .insert(WithNullable)
        .values({} as never)
        .compile(),
    ).toThrow(ValidationError)

    const withNull = db.insert(WithNullable).values({ note: null }).compile()
    expect(withNull.sql.toLowerCase()).toContain('insert')
    expect(withNull.params).toEqual([null])

    const withValue = db.insert(WithNullable).values({ note: 'hi' }).compile()
    expect(withValue.params).toEqual(['hi'])

    await db.close()
  })

  it('should accept omitted and null nested wrapper values', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [NestedWrappers] })

    const omitted = db.insert(NestedWrappers).values({ id: '1' }).compile()
    expect(omitted.params).toEqual(['1'])

    const withNull = db
      .insert(NestedWrappers)
      .values({ id: '1', optionalNullable: null, nullableOptional: null })
      .compile()
    expect(withNull.params).toEqual(['1', null, null])

    const withValues = db
      .insert(NestedWrappers)
      .values({ id: '1', optionalNullable: 'a', nullableOptional: 'b' })
      .compile()
    expect(withValues.params).toEqual(['1', 'a', 'b'])

    const updateWithNull = db
      .update(NestedWrappers)
      .set({ optionalNullable: null, nullableOptional: null })
      .where({ id: '1' })
      .compile()
    expect(updateWithNull.params).toEqual([null, null, '1'])

    const updateWithValues = db
      .update(NestedWrappers)
      .set({ optionalNullable: 'a', nullableOptional: 'b' })
      .where({ id: '1' })
      .compile()
    expect(updateWithValues.params).toEqual(['a', 'b', '1'])

    await db.close()
  })

  it('should reject invalid update patch', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() =>
      db
        .update(Users)
        .set({ email: 9 as never })
        .where({ id: 1 })
        .compile(),
    ).toThrow(ValidationError)

    expect(connector.prepared).toHaveLength(0)

    await db.close()
  })
})

describe('CRUD execute terminals', () => {
  it('should return full rows by default when calling insert.values().execute', async () => {
    const rows = [{ id: 1, email: 'a@b.com', displayName: 'Ada', active: true }]
    const connector = createMockConnector({ rowsBySql: () => rows })
    const db = createDatabase({ connector, schemas: [Users] })

    const result = await db.insert(Users).values({ email: 'a@b.com' }).execute()
    expect(result).toEqual(rows)

    expect(connector.prepared.some((s) => /returning \*/i.test(s))).toBe(true)

    await db.close()
  })

  it('should return full rows when calling insert.returningAll().execute', async () => {
    const rows = [{ id: 1, email: 'a@b.com', displayName: 'Ada', active: true }]
    const connector = createMockConnector({
      rowsBySql: () => rows,
    })
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(
      db.insert(Users).values({ email: 'a@b.com' }).returningAll().execute(),
    ).resolves.toEqual(rows)

    expect(connector.prepared.some((s) => /insert/i.test(s))).toBe(true)

    await db.close()
  })

  it('should return rows when calling executeTakeFirst on update/delete', async () => {
    const row = { id: 1, email: 'a@b.com', displayName: 'Z', active: true }
    const connector = createMockConnector({ rowsBySql: () => [row] })
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(
      db
        .update(Users)
        .set({ displayName: 'Z' })
        .where(Users.id, 'eq', 1)
        .executeTakeFirst(),
    ).resolves.toEqual(row)

    await expect(
      db.delete(Users).where({ id: 1 }).executeTakeFirstOrThrow(),
    ).resolves.toEqual(row)

    await db.close()
  })
})

describe('registry still enforces handles', () => {
  it('should reject unregistered table for from and insert', async () => {
    const Other = defineTable(
      'other',
      { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
      { primaryKey: 'id' },
    )

    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.from(Other)).toThrow(SchemaError)
    expect(() => db.insert(Other)).toThrow(SchemaError)

    await db.close()
  })
})
