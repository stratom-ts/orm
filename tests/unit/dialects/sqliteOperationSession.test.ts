import type { Connector } from 'db0'
import { expect, it } from 'vitest'

import type { OperationCommand } from '@/dialects'
import { compileSqliteOperationCommand } from '@/dialects/sqlite/operations'
import { createDb0NodeSqliteOperationSessionProvider } from '@/dialects/sqlite/operationSession'

import { customConnector } from '../helpers/operationSessionFixtures'

const invalidConnectorCases = [
  { label: 'name', override: { name: 'custom-sqlite' } },
  { label: 'dialect', override: { dialect: 'other' } },
  { label: 'missing getInstance', override: {}, omit: 'getInstance' },
  { label: 'non-function getInstance', override: { getInstance: 7 } },
  { label: 'missing dispose', override: {}, omit: 'dispose' },
  { label: 'non-function dispose', override: { dispose: 7 } },
] as const

it.each(invalidConnectorCases)(
  'rejects exact connector shape mismatch: $label',
  ({ override, ...scenario }) => {
    const connector = {
      ...customConnector('sqlite'),
      name: 'node-sqlite',
      dispose: async () => undefined,
    }

    const candidate = { ...connector, ...override } as Connector

    if ('omit' in scenario) Reflect.deleteProperty(candidate, scenario.omit)

    expect(() => createDb0NodeSqliteOperationSessionProvider(candidate)).toThrow(
      /explicit operationSessionProvider/,
    )
  },
)

const commandCases: readonly { label: string; command: OperationCommand; sql: string }[] =
  [
    { label: 'ping', command: { kind: 'ping' }, sql: 'select 1' },
    { label: 'begin', command: { kind: 'begin' }, sql: 'begin' },
    { label: 'commit', command: { kind: 'commit' }, sql: 'commit' },
    { label: 'rollback', command: { kind: 'rollback' }, sql: 'rollback' },
    {
      label: 'createSavepoint',
      command: { kind: 'createSavepoint', id: 7 },
      sql: 'savepoint sp_7',
    },
    {
      label: 'rollbackToSavepoint',
      command: { kind: 'rollbackToSavepoint', id: 7 },
      sql: 'rollback to savepoint sp_7',
    },
    {
      label: 'releaseSavepoint',
      command: { kind: 'releaseSavepoint', id: 7 },
      sql: 'release savepoint sp_7',
    },
  ]

it.each(commandCases)(
  'compiles the exact $label operation command',
  ({ command, sql }) => {
    expect(compileSqliteOperationCommand(command)).toEqual({ sql, params: [] })
  },
)
