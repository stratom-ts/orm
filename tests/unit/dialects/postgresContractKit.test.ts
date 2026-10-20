import type { DialectContractMemberCapabilities } from './dialectContractKit'
import { registerDialectContractMember } from './dialectContractKit'
import {
  postgresCoordinationContractShard,
  postgresOperationSessionContractShard,
  postgresSemanticContractShard,
} from './postgresSharedShards'

const postgresContractCapabilities = {
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

registerDialectContractMember('PostgreSQL', postgresContractCapabilities, {
  semantic: postgresSemanticContractShard,
  coordination: postgresCoordinationContractShard,
  'operation-session': postgresOperationSessionContractShard,
})
