import { expect, it } from 'vitest'

import {
  postgresOperationSessionContractShard,
  postgresSemanticContractShard,
} from './postgresSharedShards'
import {
  sqliteOperationSessionContractShard,
  sqliteSemanticContractShard,
} from './sqliteSharedShards'

const members = [
  {
    name: 'PostgreSQL',
    semantic: postgresSemanticContractShard,
    operationSession: postgresOperationSessionContractShard,
  },
  {
    name: 'SQLite',
    semantic: sqliteSemanticContractShard,
    operationSession: sqliteOperationSessionContractShard,
  },
] as const

it('keeps shared query core and value mapping supported for both production members', () => {
  for (const member of members) {
    expect(member.semantic.query.core.state).toBe('supported')
    expect(member.semantic.query.valueMapping.state).toBe('supported')
  }
})

it('keeps whole-plan lowering and rejection cases supported for both production members', () => {
  for (const member of members) {
    const migration = member.semantic.migration

    expect(migration.state).toBe('supported')
    expect(migration.input.lowering.createCase).toBeTypeOf('function')
    expect(migration.input.unsupportedLowering.state).toBe('supported')
    expect(migration.input.unsupportedLowering.input.createCase).toBeTypeOf('function')
  }
})

it('provides common and controlled provider migration cases for both members', () => {
  for (const member of members) {
    const operationSession = member.operationSession.operationSession
    const controlled = operationSession.controlled.input
    const migration = controlled.migration

    expect(operationSession.state).toBe('supported')
    expect(operationSession.common.state).toBe('supported')
    expect(operationSession.common.input.createRuntime).toBeTypeOf('function')
    expect(operationSession.controlled.state).toBe('supported')
    expect(controlled.createProvider).toBeTypeOf('function')
    expect(migration.state).toBe('supported')
    expect(migration.input.connector).toBeTypeOf('function')
    expect(migration.input.appliedSchemas).toBeTypeOf('function')
    expect(migration.input.planningFailureSchemas).toBeTypeOf('function')
  }
})

it('declares SQLite right joins unsupported with a pre-execution rejection case', () => {
  const rightJoin =
    sqliteSemanticContractShard.query.scenarios['select.join.right'].support

  expect(rightJoin.state).toBe('unsupported')
  expect(rightJoin.reason.trim()).not.toBe('')
  expect(rightJoin.expectedMessage.trim()).not.toBe('')
  expect(rightJoin.input.node.kind).toBe('select')
})
