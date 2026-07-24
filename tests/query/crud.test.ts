import { createDb } from '@/client'
import { defineTable } from '@/defineTable'
import { column } from '@/schemas'
import { QueryError, SchemaError, ValidationError } from '@/utils/error'
import type { Connector, Statement } from 'db0'
import { boolean, nullable, number, optional, pipe, string } from 'valibot'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

function createMockStatement(rows: unknown[] = []): Statement {
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

function createMockConnector(options?: {
  onPrepare?: (sql: string, params?: unknown[]) => Statement
  rowsBySql?: (sql: string) => unknown[]
}): Connector & {
  disposed: boolean
  prepared: string[]
  binds: unknown[][]
} {
  const prepared: string[] = []
  const binds: unknown[][] = []
  const connector = {
    name: 'mock',
    dialect: 'postgresql' as const,
    disposed: false,
    prepared,
    binds,
    getInstance: () => ({}),
    exec: async () => ({}),
    prepare: (sql: string) => {
      prepared.push(sql)
      const base =
        options?.onPrepare?.(sql) ??
        createMockStatement(options?.rowsBySql?.(sql) ?? [])
      return {
        bind(...params: unknown[]) {
          binds.push(params)
          return base.bind(...(params as never[]))
        },
        all: () => base.all(),
        run: () => base.run(),
        get: () => base.get(),
      }
    },
    dispose: async () => {
      connector.disposed = true
    },
  }
  return connector
}

const Users = defineTable(
  'users',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'text' })),
    displayName: optional(pipe(string(), column({ type: 'text' }))),
    active: pipe(boolean(), column({ type: 'boolean', default: true })),
  },
  { primaryKey: 'id', schema: 'public' },
)

const AlwaysId = defineTable(
  'always_id',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'always' })),
    label: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id' },
)

describe('CRUD compile', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('narrows returning row type to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    const query = db
      .insert(Users)
      .values({ email: 'a@b.com' })
      .returning([Users.id, Users.email])
    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
    expectTypeOf<Row>().not.toHaveProperty('displayName')
    expectTypeOf<Row>().not.toHaveProperty('active')
  })

  it('compiles insert with parameterized values and schema-qualified table', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
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

  it('compiles bulk insert', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
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

  it('compiles update with where and returning', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
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

  it('compiles delete with object where', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
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
})

describe('CRUD safety and validation', () => {
  it('rejects update without where unless .all()', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    expect(() => db.update(Users).set({ displayName: 'x' }).compile()).toThrow(
      QueryError,
    )
    expect(() => db.update(Users).set({ displayName: 'x' }).compile()).toThrow(
      /where|\.all\(\)/i,
    )
    const ok = db.update(Users).set({ displayName: 'x' }).all().compile()
    expect(ok.sql.toLowerCase()).toContain('update')
    expect(ok.sql.toLowerCase()).not.toContain('where')
    await db.close()
  })

  it('rejects delete without where unless .all()', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    expect(() => db.delete(Users).compile()).toThrow(QueryError)
    const ok = db.delete(Users).all().compile()
    expect(ok.sql.toLowerCase()).toContain('delete from')
    await db.close()
  })

  it('rejects invalid insert with ValidationError before SQL', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    expect(() =>
      db
        .insert(Users)
        .values({ email: 123 as never })
        .compile(),
    ).toThrow(ValidationError)
    expect(connector.prepared).toHaveLength(0)
    await db.close()
  })

  it('rejects always-generated columns on insert', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [AlwaysId] })
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

  it('requires bare nullable columns on insert but accepts null', async () => {
    const WithNullable = defineTable(
      'with_nullable',
      {
        id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
        note: nullable(pipe(string(), column({ type: 'text' }))),
      },
      { primaryKey: 'id' },
    )
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [WithNullable] })
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

  it('rejects invalid update patch', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
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
  it('insert.returningAll().execute returns rows', async () => {
    const rows = [{ id: 1, email: 'a@b.com', displayName: null, active: true }]
    const connector = createMockConnector({
      rowsBySql: () => rows,
    })
    const db = createDb({ connector, schemas: [Users] })
    await expect(
      db.insert(Users).values({ email: 'a@b.com' }).returningAll().execute(),
    ).resolves.toEqual(rows)
    expect(connector.prepared.some((s) => /insert/i.test(s))).toBe(true)
    await db.close()
  })

  it('executeTakeFirst and executeTakeFirstOrThrow on select', async () => {
    const rows = [{ id: '1', email: 'a@b.com' }]
    const connector = createMockConnector({ rowsBySql: () => rows })
    const db = createDb({ connector, schemas: [Users] })
    await expect(db.from(Users).executeTakeFirst()).resolves.toEqual(rows[0])
    await expect(db.from(Users).executeTakeFirstOrThrow()).resolves.toEqual(
      rows[0],
    )
    await db.close()
  })

  it('executeTakeFirstOrThrow throws QueryError when empty', async () => {
    const connector = createMockConnector({ rowsBySql: () => [] })
    const db = createDb({ connector, schemas: [Users] })
    await expect(
      db.from(Users).executeTakeFirstOrThrow(),
    ).rejects.toBeInstanceOf(QueryError)
    await db.close()
  })

  it('write with returning returns rows via execute', async () => {
    const rows = [{ id: 1, email: 'a@b.com', displayName: null, active: true }]
    const connector = createMockConnector({ rowsBySql: () => rows })
    const db = createDb({ connector, schemas: [Users] })
    const result = await db.insert(Users).values({ email: 'a@b.com' }).execute()
    expect(result).toEqual(rows)
    await db.close()
  })

  it('update/delete returning executeTakeFirst', async () => {
    const row = { id: 1, email: 'a@b.com', displayName: 'Z', active: true }
    const connector = createMockConnector({ rowsBySql: () => [row] })
    const db = createDb({ connector, schemas: [Users] })
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

describe('db.insert()', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('compiles insert with values()', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
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

  it('values().returningAll().execute returns rows', async () => {
    const rows = [{ id: 1, email: 'a@b.com', displayName: null, active: true }]
    const connector = createMockConnector({
      rowsBySql: () => rows,
    })
    const db = createDb({ connector, schemas: [Users] })
    await expect(
      db.insert(Users).values({ email: 'a@b.com' }).returningAll().execute(),
    ).resolves.toEqual(rows)
    expect(connector.prepared.some((s) => /insert/i.test(s))).toBe(true)
    await db.close()
  })

  it('values().execute() returns rows (returningAll is baked in)', async () => {
    const rows = [{ id: 1, email: 'a@b.com', displayName: null, active: true }]
    const connector = createMockConnector({ rowsBySql: () => rows })
    const db = createDb({ connector, schemas: [Users] })
    const result = await db.insert(Users).values({ email: 'a@b.com' }).execute()
    expect(result).toEqual(rows)
    await db.close()
  })

  it('rejects unregistered table for db.insert()', async () => {
    const Other = defineTable(
      'other',
      { id: pipe(string(), column({ type: 'text' })) },
      { primaryKey: 'id' },
    )
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    expect(() => db.insert(Other)).toThrow(SchemaError)
    await db.close()
  })

  it('rejects invalid data with ValidationError before SQL', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    expect(() =>
      db
        .insert(Users)
        .values({ email: 123 as never })
        .compile(),
    ).toThrow(ValidationError)
    expect(connector.prepared).toHaveLength(0)
    await db.close()
  })
})

describe('CRUD integration (Postgres)', () => {
  const url = process.env.DATABASE_URL

  it.skipIf(!url)(
    'insert/update/delete/returning against real Postgres',
    async () => {
      const { createDatabase } = await import('db0')
      const { default: postgresql } = await import('db0/connectors/postgresql')
      const setup = createDatabase(postgresql({ url: url as string }))
      const db = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [Users],
      })
      try {
        await setup.exec(`drop table if exists "public"."users"`)
        await setup.exec(`
          create table "public"."users" (
            "id" integer generated by default as identity primary key,
            "email" text not null,
            "displayName" text,
            "active" boolean not null default true
          )
        `)

        const inserted = await db
          .insert(Users)
          .values({ email: 'crud@test.com', displayName: 'Crud' })
          .returningAll()
          .executeTakeFirstOrThrow()
        expect(inserted.email).toBe('crud@test.com')
        expect(inserted.id).toEqual(expect.any(Number))

        const updated = await db
          .update(Users)
          .set({ displayName: 'Updated' })
          .where(Users.email, 'eq', 'crud@test.com')
          .returning([Users.displayName, Users.email])
          .executeTakeFirstOrThrow()
        expect(updated).toMatchObject({
          displayName: 'Updated',
          email: 'crud@test.com',
        })

        const deleted = await db
          .delete(Users)
          .where({ email: 'crud@test.com' })
          .execute()
        expect(deleted).toHaveLength(1)

        const remaining = await db.from(Users).execute()
        expect(remaining).toHaveLength(0)
      } finally {
        await db.close()
        await setup.dispose()
      }
    },
    30_000,
  )
})

describe('registry still enforces handles', () => {
  it('rejects unregistered table for insert', async () => {
    const Other = defineTable(
      'other',
      { id: pipe(string(), column({ type: 'text' })) },
      { primaryKey: 'id' },
    )
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    expect(() => db.from(Other)).toThrow(SchemaError)
    await db.close()
  })
})
