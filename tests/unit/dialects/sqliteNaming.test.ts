import { describe, expect, it } from 'vitest'

import { sqliteIdentity } from '@/dialects/sqlite/identity'
import { sqliteNaming } from '@/dialects/sqlite/naming'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import type { PhysicalNameRegistry } from '@/migrations/physicalNaming'
import { SchemaError } from '@/utils/error'

/**
 * Checks long valid names and rejection of unsafe or malformed identifier spellings.
 *
 * @param registry - Identity registry used to resolve registered table handles.
 * @param events - Recorded session or migration events in their observed order.
 * @param archive - Attached or alternate namespace used to check relation resolution.
 */
function assertSqliteIdentifierSafety(
  registry: PhysicalNameRegistry,
  events: CanonicalRelationIdentity,
  archive: CanonicalRelationIdentity,
) {
  expect(() =>
    registry.reserve({
      kind: 'index',
      owner: events,
      name: 'casesensitiveindex',
      token: 'events-index',
      description: 'events index',
    }),
  ).toThrow(/collision/i)

  expect(() =>
    registry.reserve({
      kind: 'index',
      owner: archive,
      name: 'casesensitiveindex',
      token: 'archive-index',
      description: 'archive index',
    }),
  ).not.toThrow()
}

const registerNamingCases1 = () => {
  it('should allow long SQLite names and validate identifier safety and collisions', () => {
    const identity = sqliteIdentity.create({
      context: {
        writableDefault: [{ role: 'database', spelling: 'main' }],
      },
    })

    const records = identity.resolve({ relation: 'records' })
    const events = identity.resolve({ relation: 'events' })
    const archive = identity.resolve({
      namespace: [{ role: 'database', spelling: 'archive' }],
      relation: 'events',
    })

    const registry = sqliteNaming.createRegistry()

    expect(() =>
      sqliteNaming.validate('a'.repeat(1024), 'long SQLite name'),
    ).not.toThrow()

    /** Validates an identifier containing NUL to exercise rejection. */
    const nulName = () => sqliteNaming.validate('has\0nul', 'NUL SQLite name')
    expect(nulName).toThrow(SchemaError)
    expect(nulName).toThrow(/must not contain NUL/i)

    /** Validates an identifier containing an unpaired surrogate to exercise rejection. */
    const unpairedSurrogate = () =>
      sqliteNaming.validate('has\ud800surrogate', 'surrogate SQLite name')

    expect(unpairedSurrogate).toThrow(SchemaError)
    expect(unpairedSurrogate).toThrow(/must not contain unpaired Unicode surrogates/i)

    registry.reserve({
      kind: 'index',
      owner: records,
      name: 'CaseSensitiveIndex',
      token: 'records-index',
      description: 'records index',
    })

    assertSqliteIdentifierSafety(registry, events, archive)
  })
}

function registerNamingGroup1() {
  describe('SQLite naming', () => {
    registerNamingCases1()
  })
}

describe('SQLite naming', () => {
  registerNamingGroup1()
})
