import type { Connector } from 'db0'
import cloudflareD1 from 'db0/connectors/cloudflare-d1'
import { describe, expect, it, vi } from 'vitest'

import { QueryError, createDatabase } from '@/index'

import {
  createControllableProvider,
  customConnector,
} from './helpers/operationSessionFixtures'

/** Observes whether automatic validation touches the connector's native resources. */
function observeConnector(connector: Connector) {
  return {
    getInstance: vi.spyOn(connector, 'getInstance'),
    exec: vi.spyOn(connector, 'exec'),
    prepare: vi.spyOn(connector, 'prepare'),
  }
}

/** Checks the actionable diagnostic without depending on punctuation. */
function assertTransactionDiagnostic(connector: Connector) {
  const access = observeConnector(connector)
  let failure: unknown

  try {
    createDatabase({ connector, schemas: [] })
  } catch (cause) {
    failure = cause
  }

  expect(failure).toBeInstanceOf(QueryError)

  expect(failure).toHaveProperty(
    'message',
    expect.stringContaining(`"${connector.name}"`),
  )

  expect(failure).toHaveProperty(
    'message',
    expect.stringContaining('cannot keep a transaction across statements'),
  )

  expect(failure).toHaveProperty(
    'message',
    expect.stringContaining('pinned sessions with native transactions'),
  )

  expect(failure).toHaveProperty(
    'message',
    expect.stringMatching(
      /operationSessionProvider.*underlying client's native transaction API/,
    ),
  )

  expect(failure).toHaveProperty(
    'message',
    expect.stringMatching(/Client\.transaction\(\).*not db0/),
  )

  expect(access.getInstance).not.toHaveBeenCalled()
  expect(access.exec).not.toHaveBeenCalled()
  expect(access.prepare).not.toHaveBeenCalled()
}

const dialectCases = [
  {
    dialect: 'postgresql',
    supportedName: 'postgresql',
    genericMessage:
      'Automatic operation sessions require the db0 PostgreSQL connector; provide an explicit operationSessionProvider for a custom connector',
  },
  {
    dialect: 'sqlite',
    supportedName: 'node-sqlite',
    genericMessage:
      'Automatic SQLite operation sessions require db0 node-sqlite; provide an explicit operationSessionProvider for other connectors',
  },
] as const

describe('automatic connector transaction diagnostics', () => {
  it('should explain the D1 transaction limit before accessing a binding', () => {
    assertTransactionDiagnostic(cloudflareD1({ bindingName: 'UNAVAILABLE_TEST_BINDING' }))
  })

  it.each(dialectCases)(
    'should honor false capability overrides for $dialect custom connectors',
    ({ dialect }) => {
      const connector = customConnector(dialect)
      connector.capabilityOverrides = { transactions: false }
      assertTransactionDiagnostic(connector)
    },
  )

  it.each(dialectCases)(
    'should honor false capability overrides for $supportedName',
    ({ dialect, supportedName }) => {
      const connector: Connector = {
        ...customConnector(dialect),
        name: supportedName,
        capabilityOverrides: { transactions: false },
        dispose: vi.fn<() => void>(),
      }

      assertTransactionDiagnostic(connector)
      expect(connector.dispose).not.toHaveBeenCalled()
    },
  )
})

describe('automatic connector support checks', () => {
  it.each(dialectCases)(
    'should retain the exact-provider rejection for transaction-capable $dialect connectors',
    ({ dialect, genericMessage }) => {
      const connector = customConnector(dialect)
      connector.capabilityOverrides = { transactions: true }
      expect(() => createDatabase({ connector, schemas: [] })).toThrow(genericMessage)
    },
  )
})

describe('explicit session provider capability independence', () => {
  it.each(dialectCases)(
    'should use an explicit provider despite disabled $dialect connector transactions',
    async ({ dialect }) => {
      const connector = customConnector(dialect)
      connector.capabilityOverrides = { transactions: false }
      const access = observeConnector(connector)
      const controls = createControllableProvider()
      const db = createDatabase({
        connector,
        schemas: [],
        operationSessionProvider: controls.provider,
      })

      try {
        await db.ping()
        expect(controls.calls).toEqual([{ session: 1, sql: 'select 1' }])
      } finally {
        await db.close()
      }

      expect(controls.closeCount).toBe(1)
      expect(access.getInstance).not.toHaveBeenCalled()
      expect(access.exec).not.toHaveBeenCalled()
      expect(access.prepare).not.toHaveBeenCalled()
    },
  )
})
