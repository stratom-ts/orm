import { afterEach, vi } from 'vitest'

import type { DialectContractMemberCapabilities } from './dialectContractKit'
import { registerDialectContractMember } from './dialectContractKit'
import {
  sqliteCoordinationContractShard,
  sqliteOperationSessionContractShard,
  sqliteSemanticContractShard,
} from './sqliteSharedShards'

afterEach(() => {
  vi.restoreAllMocks()
})

const sqliteContractCapabilities = {
  identity: { state: 'supported', shard: 'semantic' },
  naming: { state: 'supported', shard: 'semantic' },
  desiredSchema: { state: 'supported', shard: 'semantic' },
  query: { state: 'supported', shard: 'semantic' },
  catalog: { state: 'supported', shard: 'semantic' },
  operationSession: { state: 'supported', shard: 'operation-session' },
  coordination: { state: 'supported', shard: 'coordination' },
  migration: { state: 'supported', shard: 'semantic' },
  lifecycle: { state: 'supported', shard: 'semantic' },
} as const satisfies DialectContractMemberCapabilities

registerDialectContractMember('SQLite', sqliteContractCapabilities, {
  semantic: sqliteSemanticContractShard,
  coordination: sqliteCoordinationContractShard,
  'operation-session': sqliteOperationSessionContractShard,
})
