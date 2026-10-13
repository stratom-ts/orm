import { describe, expect, it } from 'vitest'

import { POSTGRES_POLICY } from '@/dialects/postgres/identity'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { SchemaError } from '@/utils/error'

import { SQLITE_IDENTITY_POLICY } from '../helpers/dialectPolicies'

const POSTGRES_CONTEXT = {
  writableDefault: [
    { role: 'database' as const, spelling: 'app_db' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

const SQLITE_CONTEXT = {
  writableDefault: [{ role: 'database' as const, spelling: 'main' }],
}

describe('canonical relation identity', () => {
  it('preserves spelling and compares ordered namespace roles structurally', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: POSTGRES_POLICY,
      context: POSTGRES_CONTEXT,
    })

    const identity = identities.resolve({
      namespace: [{ role: 'schema', spelling: 'App.Schema' }],
      relation: 'User"Profile',
    })

    const differentRole: CanonicalRelationIdentity = {
      ...identity,
      namespace: [identity.namespace[0]!, { ...identity.namespace[1]!, role: 'catalog' }],
    }

    expect(identity).toEqual({
      namespace: [
        {
          role: 'database',
          identifier: { spelling: 'app_db', comparisonKey: 'app_db' },
        },
        {
          role: 'schema',
          identifier: { spelling: 'App.Schema', comparisonKey: 'App.Schema' },
        },
      ],
      relation: { spelling: 'User"Profile', comparisonKey: 'User"Profile' },
    })

    expect(identities.equals(identity, differentRole)).toBe(false)
  })
})

describe('canonical relation identity: keeps dotted, quoted, case-distinct, and Unicode tuples separate', () => {
  it('keeps dotted, quoted, case-distinct, and Unicode tuples separate', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: POSTGRES_POLICY,
      context: POSTGRES_CONTEXT,
    })

    const inputs = [
      { namespace: [{ role: 'schema' as const, spelling: 'a.b' }], relation: 'c' },
      { namespace: [{ role: 'schema' as const, spelling: 'a' }], relation: 'b.c' },
      { namespace: [{ role: 'schema' as const, spelling: 'a"b' }], relation: 'c' },
      { namespace: [{ role: 'schema' as const, spelling: 'a' }], relation: 'C' },
      { namespace: [{ role: 'schema' as const, spelling: 'a' }], relation: 'c' },
      { namespace: [{ role: 'schema' as const, spelling: 'a' }], relation: 'cafe\u0301' },
      { namespace: [{ role: 'schema' as const, spelling: 'a' }], relation: 'caf\u00e9' },
    ]

    const registry = identities.createRegistry<number>()

    inputs.forEach((input, index) => registry.set(identities.resolve(input), index))

    expect(inputs.map((input) => registry.get(identities.resolve(input)))).toEqual(
      inputs.map((_, index) => index),
    )
  })
})

describe('canonical relation identity: resolves PostgreSQL omission from registration before session context', () => {
  it('resolves PostgreSQL omission from registration before session context', () => {
    const sessionIdentities = createCanonicalRelationIdentityModule({
      policy: POSTGRES_POLICY,
      context: POSTGRES_CONTEXT,
    })

    const registeredIdentities = createCanonicalRelationIdentityModule({
      policy: POSTGRES_POLICY,
      context: POSTGRES_CONTEXT,
      registrationDefault: [{ role: 'schema', spelling: 'tenant' }],
    })

    expect(
      sessionIdentities.equals(
        sessionIdentities.resolve({ relation: 'users' }),
        sessionIdentities.resolve({
          namespace: [{ role: 'schema', spelling: 'public' }],
          relation: 'users',
        }),
      ),
    ).toBe(true)

    expect(
      registeredIdentities.equals(
        registeredIdentities.resolve({ relation: 'users' }),
        registeredIdentities.resolve({
          namespace: [{ role: 'schema', spelling: 'tenant' }],
          relation: 'users',
        }),
      ),
    ).toBe(true)

    expect(
      registeredIdentities.equals(
        registeredIdentities.resolve({ relation: 'users' }),
        registeredIdentities.resolve({
          namespace: [{ role: 'schema', spelling: 'public' }],
          relation: 'users',
        }),
      ),
    ).toBe(false)
  })
})

describe('canonical relation identity: treats an empty PostgreSQL namespace as omitted', () => {
  it('treats an empty PostgreSQL namespace as omitted', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: POSTGRES_POLICY,
      context: POSTGRES_CONTEXT,
      registrationDefault: [{ role: 'schema', spelling: 'tenant' }],
    })

    expect(
      identities.equals(
        identities.resolve({ namespace: [], relation: 'users' }),
        identities.resolve({
          namespace: [{ role: 'schema', spelling: 'tenant' }],
          relation: 'users',
        }),
      ),
    ).toBe(true)
  })

  it('sorts comparison-key tuples by locale-independent UTF-16 code units', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: POSTGRES_POLICY,
      context: POSTGRES_CONTEXT,
    })

    const ordered = ['A', 'Z', 'a', '\u00e9', '\ud83d\ude00']
    const shuffled = ['\ud83d\ude00', 'a', '\u00e9', 'Z', 'A'].map((relation) =>
      identities.resolve({ relation }),
    )

    shuffled.sort((left, right) => identities.compare(left, right))

    expect(shuffled.map((identity) => identity.relation.spelling)).toEqual(ordered)
  })
})

describe('canonical relation identity: models PostgreSQL as database/schema/relation', () => {
  it('models PostgreSQL as database/schema/relation', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: POSTGRES_POLICY,
      context: POSTGRES_CONTEXT,
    })

    expect(identities.resolve({ relation: 'events' })).toEqual({
      namespace: [
        {
          role: 'database',
          identifier: { spelling: 'app_db', comparisonKey: 'app_db' },
        },
        {
          role: 'schema',
          identifier: { spelling: 'public', comparisonKey: 'public' },
        },
      ],
      relation: { spelling: 'events', comparisonKey: 'events' },
    })

    expect(identities.resolveNamespace()).toEqual(
      identities.resolve({ relation: 'events' }).namespace,
    )
  })
})

describe('canonical SQLite relation identity', () => {
  it('models SQLite as database-alias/relation with ASCII-insensitive keys', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: SQLITE_IDENTITY_POLICY,
      context: SQLITE_CONTEXT,
    })

    const omitted = identities.resolve({ relation: 'Users' })
    const explicit = identities.resolve({
      namespace: [{ role: 'database', spelling: 'MAIN' }],
      relation: 'users',
    })

    const attached = identities.resolve({
      namespace: [{ role: 'database', spelling: 'audit' }],
      relation: 'users',
    })

    expect(omitted).toEqual({
      namespace: [
        {
          role: 'database',
          identifier: { spelling: 'main', comparisonKey: 'main' },
        },
      ],
      relation: { spelling: 'Users', comparisonKey: 'users' },
    })

    expect(identities.equals(omitted, explicit)).toBe(true)
    expect(identities.equals(omitted, attached)).toBe(false)
  })
})

describe('canonical SQLite relation identity: resolves SQLite omission from registration before session context', () => {
  it('resolves SQLite omission from registration before session context', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: SQLITE_IDENTITY_POLICY,
      context: SQLITE_CONTEXT,
      registrationDefault: [{ role: 'database', spelling: 'audit' }],
    })

    expect(
      identities.equals(
        identities.resolve({ relation: 'events' }),
        identities.resolve({
          namespace: [{ role: 'database', spelling: 'audit' }],
          relation: 'events',
        }),
      ),
    ).toBe(true)

    expect(
      identities.equals(
        identities.resolve({ relation: 'events' }),
        identities.resolve({
          namespace: [{ role: 'database', spelling: 'main' }],
          relation: 'events',
        }),
      ),
    ).toBe(false)
  })

  it('compares SQLite namespace roles structurally', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: SQLITE_IDENTITY_POLICY,
      context: SQLITE_CONTEXT,
    })

    const identity = identities.resolve({ relation: 'events' })
    const differentRole: CanonicalRelationIdentity = {
      ...identity,
      namespace: [{ ...identity.namespace[0]!, role: 'catalog' }],
    }

    expect(identities.equals(identity, differentRole)).toBe(false)
  })
})

describe('canonical SQLite relation identity: keeps SQLite tuples collision-free under its comparison keys', () => {
  it('keeps SQLite tuples collision-free under its comparison keys', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: SQLITE_IDENTITY_POLICY,
      context: SQLITE_CONTEXT,
    })

    const inputs = [
      { namespace: [{ role: 'database' as const, spelling: 'a.b' }], relation: 'c' },
      { namespace: [{ role: 'database' as const, spelling: 'a' }], relation: 'b.c' },
      { namespace: [{ role: 'database' as const, spelling: 'a"b' }], relation: 'c' },
      { namespace: [{ role: 'database' as const, spelling: 'a' }], relation: 'b"c' },
      {
        namespace: [{ role: 'database' as const, spelling: 'a' }],
        relation: 'caf\u00e9',
      },
      {
        namespace: [{ role: 'database' as const, spelling: 'a' }],
        relation: 'cafe\u0301',
      },
    ]

    const registry = identities.createRegistry<number>()

    inputs.forEach((input, index) => registry.set(identities.resolve(input), index))

    expect(inputs.map((input) => registry.get(identities.resolve(input)))).toEqual(
      inputs.map((_, index) => index),
    )

    expect(
      identities.equals(
        identities.resolve({ relation: 'Users' }),
        identities.resolve({ relation: 'users' }),
      ),
    ).toBe(true)

    registry.set(identities.resolve({ relation: 'Users' }), 42)
    expect(registry.get(identities.resolve({ relation: 'users' }))).toBe(42)

    expect(
      identities.equals(
        identities.resolve({ relation: 'caf\u00e9' }),
        identities.resolve({ relation: 'cafe\u0301' }),
      ),
    ).toBe(false)
  })
})

describe('canonical SQLite relation identity: keeps SQLite tuples collision-free under its comparison keys: sorts SQLite comparison keys by locale-independent UTF-16 code units', () => {
  it('sorts SQLite comparison keys by locale-independent UTF-16 code units', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: SQLITE_IDENTITY_POLICY,
      context: SQLITE_CONTEXT,
    })

    const shuffled = ['\ud83d\ude00', 'Z', '\u00e9', 'a'].map((relation) =>
      identities.resolve({ relation }),
    )

    shuffled.sort((left, right) => identities.compare(left, right))

    expect(shuffled.map((identity) => identity.relation.spelling)).toEqual([
      'a',
      'Z',
      '\u00e9',
      '\ud83d\ude00',
    ])
  })
})

describe('canonical SQLite relation identity: rejects invalid identifiers and dialect namespace shapes', () => {
  it('rejects invalid identifiers and dialect namespace shapes', () => {
    const postgres = createCanonicalRelationIdentityModule({
      policy: POSTGRES_POLICY,
      context: POSTGRES_CONTEXT,
    })

    const sqlite = createCanonicalRelationIdentityModule({
      policy: SQLITE_IDENTITY_POLICY,
      context: SQLITE_CONTEXT,
    })

    expect(() => postgres.resolve({ relation: '' })).toThrow(SchemaError)
    expect(() => postgres.resolve({ relation: 'a\0b' })).toThrow(SchemaError)
    expect(() => postgres.resolve({ relation: '\ud800' })).toThrow(SchemaError)

    expect(() =>
      postgres.resolve({
        namespace: [
          { role: 'database', spelling: 'other_db' },
          { role: 'schema', spelling: 'public' },
        ],
        relation: 'users',
      }),
    ).toThrow(/writable database/)

    expect(() =>
      sqlite.resolve({
        namespace: [{ role: 'schema', spelling: 'main' }],
        relation: 'users',
      }),
    ).toThrow(/ordered roles database/)
  })
})
