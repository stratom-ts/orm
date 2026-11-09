import type {
  MigrationIndexTarget,
  MigrationStep,
  PlannedMigration,
} from '@/ddl/migrationPlan'
import type {
  MigrationAction,
  MigrationCapabilityIssue,
  MigrationLoweringPolicy,
} from '@/ddl/migrationProgram'
import { migrationTargetsEqual } from '@/ddl/migrationProgram'
import type { CatalogIndex, CatalogRelation, CatalogTable } from '@/dialects/catalog'

import type { ActionDraft } from './orderActions'
import { compilePostgresDdl } from './sql'
import { stepToAst } from './targets'

/** Existing-table standalone indexes are the only transaction-forbidden operations. */
function isConcurrentIndex(
  draft: ActionDraft,
  planned: PlannedMigration,
  policy: MigrationLoweringPolicy,
): boolean {
  const { step } = draft

  if (
    !policy.concurrentIndexes ||
    (step.kind !== 'create_index' && step.kind !== 'drop_index')
  )
    return false

  return !planned.plan.steps.some(
    (candidate) =>
      candidate.kind === 'create_table' &&
      planned.identities.equals(candidate.target.relation, step.target.relation),
  )
}

/**
 * Compiles concurrency and recovery from catalog evidence, never from name existence
 * alone.
 */
function concurrentActions(
  draft: ActionDraft,
  planned: PlannedMigration,
  policy: MigrationLoweringPolicy,
  issues: MigrationCapabilityIssue[],
): MigrationAction[] {
  const ordinary: MigrationAction = {
    sourceStepIndexes: [draft.sourceStepIndex],
    transaction: 'required',
    ...(policy.concurrentIndexes ? { target: draft.step.target } : {}),
    statements: [draft.statement],
  }

  const { step } = draft

  if (step.kind !== 'create_index' && step.kind !== 'drop_index') return [ordinary]

  const { relation, table, observed, repairTarget } = indexEvidence(step, planned)

  const invalid =
    observed?.validity.state === 'present' && observed.validity.value === 'invalid'

  const concurrent = isConcurrentIndex(draft, planned, policy)

  if (!concurrent && !invalid) return [ordinary]

  const supported =
    concurrent && supportsConcurrentTarget(relation, table, observed, step.kind)

  if (!supported) {
    issues.push({
      code: 'invalid_target',
      message:
        'Concurrent index operations and invalid-index recovery require a supported standalone index on an existing ordinary PostgreSQL table',
      sourceStepIndexes: [draft.sourceStepIndex],
    })

    return []
  }

  const ast = stepToAst(step, planned)

  if (!ast || (ast.kind !== 'create_index' && ast.kind !== 'drop_index')) return []

  const action: MigrationAction = {
    ...ordinary,
    target: step.target,
    transaction: 'forbidden',
    statements: [compilePostgresDdl({ ...ast, concurrently: true })],
  }

  if (!invalid || step.kind !== 'create_index') return [action]

  return repairActions(action, ast.schema, ast.table, repairTarget ?? step.target)
}

function indexEvidence(
  step: Extract<MigrationStep, { kind: 'create_index' | 'drop_index' }>,
  planned: PlannedMigration,
) {
  const relation = planned.catalogSnapshot.namespaces.items
    .flatMap((namespace) => namespace.relations.items)
    .find((entry) => planned.identities.equals(entry.identity, step.target.relation))

  const table = relation?.table.state === 'present' ? relation.table.value : undefined
  const repairTarget = planned.indexRepairs?.find((repair) =>
    migrationTargetsEqual(repair.target, step.target),
  )?.from

  const observed = table?.indexes.items.find(
    (entry) =>
      entry.name.state === 'present' &&
      entry.name.value === (repairTarget ?? step.target).index.spelling,
  )

  return { relation, table, observed, repairTarget }
}

function supportsConcurrentTarget(
  relation: CatalogRelation | undefined,
  table: CatalogTable | undefined,
  observed: CatalogIndex | undefined,
  kind: 'create_index' | 'drop_index',
): boolean {
  return (
    relation?.kind === 'table' &&
    relation.persistence !== 'temporary' &&
    table?.indexes.coverage.state === 'complete' &&
    (kind === 'create_index' || observed !== undefined) &&
    (!observed || (observed.origin === 'user' && observed.semantics.state === 'present'))
  )
}

function repairActions(
  action: MigrationAction,
  schema: string,
  table: string,
  target: MigrationIndexTarget,
): MigrationAction[] {
  return [
    {
      ...action,
      target,
      repair: 'drop',
      statements: [
        compilePostgresDdl({
          kind: 'drop_index',
          schema,
          table,
          index: target.index.spelling,
          concurrently: true,
        }),
      ],
    },
    { ...action, repair: 'create' },
  ]
}

export { concurrentActions, isConcurrentIndex }
