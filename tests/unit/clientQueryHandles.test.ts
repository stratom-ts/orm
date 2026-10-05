import { pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { column, createDatabase, defineTable } from '@/index'

import { createMockPostgresConnector } from './helpers/nativePostgresClient'

const Accounts = defineTable(
  'accounts',
  { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'billing' }] },
)

const AuditEvents = defineTable(
  'events',
  { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'audit' }] },
)

type QueryRoot = 'from' | 'insert' | 'update' | 'delete'

const tableHandleBrand = Symbol.for('stratom.TableHandle')
const forgedHandle = {
  [tableHandleBrand]: true,
  /** Returns the table's original Valibot schema for validation and metadata lookup. */
  getSchema: () => undefined,
  /**
   * Returns the relation, primary-key, index, and ownership metadata attached to the
   * table.
   */
  getTableMetadata: () => undefined,
}

const malformedHandleMutations = [
  ['a brand value other than true', 'falseBrand'],
  ['a missing getSchema method', 'missingSchema'],
  ['a missing getTableMetadata method', 'missingMetadata'],
  ['a non-callable getSchema method', 'nonCallableSchema'],
  ['a non-callable getTableMetadata method', 'nonCallableMetadata'],
  ['a replacement getSchema method', 'replacementSchema'],
  ['a replacement getTableMetadata method', 'replacementMetadata'],
  ['a throwing getTableMetadata getter', 'throwingMetadataGetter'],
] as const

type MalformedHandleMutation = (typeof malformedHandleMutations)[number][1]

/**
 * Creates the malformed defined handle fixture used by the contract scenario.
 *
 * @param mutation - Variation applied to otherwise valid native observations.
 *
 * @returns The malformed defined handle fixture used by the contract scenario.
 */
function createMalformedDefinedHandle(mutation: MalformedHandleMutation) {
  const handle = defineTable(
    'malformed',
    { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
    { primaryKey: 'id' },
  )

  const mutableHandle = handle as unknown as Record<PropertyKey, unknown>

  switch (mutation) {
    case 'falseBrand':
      mutableHandle[tableHandleBrand] = false
      break
    case 'missingSchema':
      Reflect.deleteProperty(mutableHandle, 'getSchema')
      break
    case 'missingMetadata':
      Reflect.deleteProperty(mutableHandle, 'getTableMetadata')
      break
    case 'nonCallableSchema':
      mutableHandle.getSchema = null
      break
    case 'nonCallableMetadata':
      mutableHandle.getTableMetadata = 'metadata'
      break
    case 'replacementSchema':
      mutableHandle.getSchema = () => undefined
      break
    case 'replacementMetadata':
      mutableHandle.getTableMetadata = () => undefined
      break
    case 'throwingMetadataGetter':
      Object.defineProperty(mutableHandle, 'getTableMetadata', {
        configurable: true,
        /** Returns the first fixture row, or undefined when no rows exist. */
        get() {
          throw new Error('unexpected metadata access')
        },
      })

      break
  }

  return handle
}

/**
 * Invokes the selected query entry point with the supplied table candidate.
 *
 * @param db - Database client exercised by this test scenario.
 * @param method - Public query entry point whose table-handle validation is exercised.
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns The selected table query or write entry point; invalid handles throw.
 */
function startQuery(
  db: ReturnType<typeof createDatabase>,
  method: QueryRoot,
  value: never,
) {
  switch (method) {
    case 'from':
      return db.from(value)
    case 'insert':
      return db.insert(value)
    case 'update':
      return db.update(value)
    case 'delete':
      return db.delete(value)
  }
}

describe('client query table handles', () => {
  it('createDatabase rejects a fully shaped forged handle before connector work', () => {
    const connector = createMockPostgresConnector()
    const getInstance = vi.spyOn(connector, 'getInstance')

    expect(() => createDatabase({ connector, schemas: [forgedHandle as never] })).toThrow(
      expect.objectContaining({ _tag: 'SchemaError' }),
    )

    expect(getInstance).not.toHaveBeenCalled()
    expect(connector.prepared).toEqual([])
  })

  it.each(malformedHandleMutations)(
    'createDatabase rejects a defined handle with %s before connector work',
    (_description, mutation) => {
      const handle = createMalformedDefinedHandle(mutation)
      const connector = createMockPostgresConnector()
      const getInstance = vi.spyOn(connector, 'getInstance')

      expect(() => createDatabase({ connector, schemas: [handle as never] })).toThrow(
        expect.objectContaining({ _tag: 'SchemaError' }),
      )

      expect(getInstance).not.toHaveBeenCalled()
      expect(connector.prepared).toEqual([])
    },
  )
})

describe('client query table handles: %s rejects a fully shaped forged handle before database work', () => {
  it.each<QueryRoot>(['from', 'insert', 'update', 'delete'])(
    '%s rejects a fully shaped forged handle before database work',
    async (method) => {
      const connector = createMockPostgresConnector()
      const getInstance = vi.spyOn(connector, 'getInstance')
      const db = createDatabase({ connector, schemas: [Accounts] })

      expect(() => startQuery(db, method, forgedHandle as never)).toThrow(
        expect.objectContaining({
          _tag: 'SchemaError',
          message: expect.stringContaining(`db.${method}()`) as unknown,
        }),
      )

      expect(getInstance).not.toHaveBeenCalled()
      expect(connector.prepared).toEqual([])
      await db.close()
    },
  )

  it.each(malformedHandleMutations)(
    'query roots reject a defined handle with %s before database work',
    async (_description, mutation) => {
      const handle = createMalformedDefinedHandle(mutation)
      const connector = createMockPostgresConnector()
      const getInstance = vi.spyOn(connector, 'getInstance')
      const db = createDatabase({ connector, schemas: [Accounts] })

      for (const method of ['from', 'insert', 'update', 'delete'] as const) {
        expect(() => startQuery(db, method, handle as never)).toThrow(
          expect.objectContaining({
            _tag: 'SchemaError',
            message: expect.stringContaining(`db.${method}()`) as unknown,
          }),
        )
      }

      expect(getInstance).not.toHaveBeenCalled()
      expect(connector.prepared).toEqual([])
      await db.close()
    },
  )
})

describe('client query table handles: recognizes handles created by a reloaded package module', () => {
  it('recognizes handles created by a reloaded package module', async () => {
    vi.resetModules()
    const { isTableHandle } = await import('@/defineTable')

    expect(isTableHandle(Accounts)).toBe(true)
  })
})

describe('client query table handles: %s rejects a non-handle with a tagged schema error before database work', () => {
  it.each<QueryRoot>(['from', 'insert', 'update', 'delete'])(
    '%s rejects a non-handle with a tagged schema error before database work',
    async (method) => {
      const connector = createMockPostgresConnector()
      const db = createDatabase({ connector, schemas: [Accounts] })

      expect(() => startQuery(db, method, { relation: 'accounts' } as never)).toThrow(
        expect.objectContaining({
          _tag: 'SchemaError',
          message: expect.stringContaining(`db.${method}()`) as unknown,
        }),
      )

      expect(connector.prepared).toEqual([])
      await db.close()
    },
  )
})

describe('client query table handles: %s rejects an unregistered handle with the same tagged error contract before database work', () => {
  it.each<QueryRoot>(['from', 'insert', 'update', 'delete'])(
    '%s rejects an unregistered handle with the same tagged error contract before database work',
    async (method) => {
      const connector = createMockPostgresConnector()
      const db = createDatabase({ connector, schemas: [Accounts] })

      expect(() => startQuery(db, method, AuditEvents as never)).toThrow(
        expect.objectContaining({
          _tag: 'SchemaError',
          message: expect.stringMatching(/not registered/i) as unknown,
        }),
      )

      expect(connector.prepared).toEqual([])
      await db.close()
    },
  )
})
