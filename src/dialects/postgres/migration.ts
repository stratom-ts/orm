import type {
  MigrationColumnReference,
  MigrationSemanticProfile,
  MigrationStep,
  PlannedMigration,
} from '@/ddl/migrationPlan'
import type {
  MigrationAction,
  MigrationCapabilityIssue,
  MigrationLoweringResult,
  MigrationPrecondition,
  MigrationRuntimeOptions,
} from '@/ddl/migrationProgram'
import type {
  CompiledQuery,
  CreateSchemaAst,
  CreateTableAst,
  SqlAst,
} from '@/dialects/types'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import {
  MIGRATE_ADVISORY_LOCK_CLASS,
  MIGRATE_ADVISORY_LOCK_ID,
  createMigrationCoordinationScope,
} from '@/migrations/coordinationScope'
import {
  generatedForeignKeyName,
  generatedPrimaryKeyName,
  generatedUniqueName,
  physicalNamingProfile,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import type { MigrationCleanupFailure, MigrationExecutionStage } from '@/utils/error'
import { MigrationError } from '@/utils/error'

import { compilePostgres } from './compile'

type ActionDraft = {
  step: MigrationStep
  sourceStepIndex: number
  statement: CompiledQuery
}

/** Reads the schema spelling a PostgreSQL statement must name. */
function schemaFromNamespace(namespace: CanonicalRelationIdentity['namespace']): string {
  const schema = namespace.find((segment) => segment.role === 'schema')
  if (!schema) throw new Error('PostgreSQL migration target has no schema namespace')
  return schema.identifier.spelling
}

/** Projects a canonical relation identity into PostgreSQL AST relation fields. */
function relationFields(identity: CanonicalRelationIdentity) {
  return {
    schema: schemaFromNamespace(identity.namespace),
    table: identity.relation.spelling,
  }
}

/** Projects a structured foreign-key reference into PostgreSQL AST fields. */
function referenceFields(reference: MigrationColumnReference) {
  return {
    ...relationFields(reference.relation),
    column: reference.column.spelling,
    ...(reference.onDelete === undefined ? {} : { onDelete: reference.onDelete }),
    ...(reference.onUpdate === undefined ? {} : { onUpdate: reference.onUpdate }),
  }
}

/** Converts one semantic step into its PostgreSQL statement AST. */
function stepToAst(step: MigrationStep, planned: PlannedMigration): SqlAst | undefined {
  const profile = physicalNamingProfile('postgresql')
  switch (step.kind) {
    case 'ensure_namespace': {
      const ast: CreateSchemaAst = {
        kind: 'create_schema',
        schema: schemaFromNamespace(step.target.namespace),
      }
      return ast
    }
    case 'create_table': {
      const identity = step.target.relation
      const ast = planned.desiredTables.get(identity)
      if (!ast) return undefined
      const projected: CreateTableAst = {
        ...ast,
        ...relationFields(identity),
        primaryKeyName: generatedPrimaryKeyName(identity, ast.primaryKey, profile),
        columns: ast.columns.map((column) => ({
          ...column,
          references: undefined,
          ...(column.unique
            ? {
                uniqueConstraintName: generatedUniqueName(identity, column.name, profile),
              }
            : {}),
        })),
      }
      return projected
    }
    case 'add_column': {
      const identity = step.target.relation
      const column = step.target.column.spelling
      return {
        kind: 'add_column',
        ...relationFields(identity),
        column: {
          name: column,
          dataType: step.dataType,
          notNull: step.notNull,
          unique: step.unique ?? false,
          ...(step.unique
            ? { uniqueConstraintName: generatedUniqueName(identity, column, profile) }
            : {}),
          autoIncrement: step.autoIncrement ?? false,
          ...(step.defaultValue !== undefined ? { defaultValue: step.defaultValue } : {}),
          ...(step.databaseDefault !== undefined
            ? { databaseDefault: step.databaseDefault }
            : {}),
          ...(step.generated ? { generated: step.generated } : {}),
        },
      }
    }
    case 'alter_column_type':
      return {
        kind: 'alter_column_type',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
        dataType: step.dataType,
      }
    case 'add_unique_constraint':
      return {
        kind: 'add_unique_constraint',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
        name: generatedUniqueName(
          step.target.relation,
          step.target.column.spelling,
          profile,
        ),
      }
    case 'add_foreign_key':
      return {
        kind: 'add_foreign_key',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
        name: generatedForeignKeyName(
          step.target.relation,
          step.target.column.spelling,
          step.references.relation,
          step.references.column.spelling,
          step.references.onDelete,
          step.references.onUpdate,
          profile,
        ),
        references: referenceFields(step.references),
      }
    case 'set_not_null':
      return {
        kind: 'set_not_null',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
      }
    case 'drop_not_null':
      return {
        kind: 'drop_not_null',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
      }
    case 'create_index':
      return {
        kind: 'create_index',
        ...relationFields(step.target.relation),
        name: step.target.index.spelling,
        columns: step.columns.map((column) => column.spelling),
        unique: step.unique,
      }
    case 'drop_column':
      return {
        kind: 'drop_column',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
      }
    case 'drop_table':
      return { kind: 'drop_table', ...relationFields(step.target.relation) }
    case 'drop_index':
      return {
        kind: 'drop_index',
        ...relationFields(step.target.relation),
        index: step.target.index.spelling,
      }
  }
}

/** Compares authored namespace inputs under canonical PostgreSQL identity rules. */
function sameNamespaceInput(
  left: readonly NamespaceIdentifierInput[] | undefined,
  right: readonly NamespaceIdentifierInput[] | undefined,
  identities: CanonicalRelationIdentityModule,
): boolean {
  const resolve = (input: readonly NamespaceIdentifierInput[] | undefined) => {
    if (!input?.length) return undefined
    try {
      return identities.resolveNamespace(input)
    } catch {
      return null
    }
  }
  const selected = resolve(left)
  const other = resolve(right)
  if (selected == null || other == null) {
    return selected === undefined && other === undefined
  }
  return (
    selected.length === other.length &&
    selected.every(
      (segment, index) =>
        segment.role === other[index]?.role &&
        segment.identifier.comparisonKey === other[index]?.identifier.comparisonKey,
    )
  )
}

/** Collects every deterministic semantic-profile mismatch. */
function profileIssues(
  planned: PlannedMigration,
  expected: MigrationSemanticProfile,
): MigrationCapabilityIssue[] {
  const issues: MigrationCapabilityIssue[] = []
  const add = (message: string) =>
    issues.push({ code: 'profile_mismatch', message, sourceStepIndexes: [] })
  if (expected.identityAdapter !== 'postgresql') {
    add(
      `Executing profile adapter '${expected.identityAdapter}' does not match PostgreSQL`,
    )
  }
  if (planned.profile.identityAdapter !== expected.identityAdapter) {
    add(
      `Identity adapter '${planned.profile.identityAdapter}' does not match executing adapter '${expected.identityAdapter}'`,
    )
  }
  if (
    !sameNamespaceInput(
      planned.profile.namespaceContext.writableDefault,
      expected.namespaceContext.writableDefault,
      planned.identities,
    )
  ) {
    add('Writable namespace context does not match the executing session')
  }
  if (
    !sameNamespaceInput(
      planned.profile.registrationDefault,
      expected.registrationDefault,
      planned.identities,
    )
  ) {
    add('Registration default does not match the executing configuration')
  }
  return issues
}

/** Validates one canonical PostgreSQL identifier and its physical spelling. */
function identifierIssues(identifier: CanonicalIdentifier, label: string): string[] {
  const issues: string[] = []
  if (identifier.comparisonKey !== identifier.spelling) {
    issues.push(`${label} is not canonical under PostgreSQL identifier rules`)
  }
  try {
    validatePhysicalName(identifier.spelling, label, physicalNamingProfile('postgresql'))
  } catch (cause) {
    issues.push(cause instanceof Error ? cause.message : `${label} is not addressable`)
  }
  return issues
}

/** Validates the exact database+schema shape PostgreSQL target projection requires. */
function namespaceIssues(
  namespace: CanonicalRelationIdentity['namespace'],
  expectedDatabase: CanonicalIdentifier | undefined,
  label: string,
): string[] {
  const issues: string[] = []
  if (namespace.length !== 2) {
    issues.push(`${label} must contain exactly database and schema segments`)
  }
  const database = namespace[0]
  const schema = namespace[1]
  if (database?.role !== 'database') {
    issues.push(`${label} segment 0 must have role 'database'`)
  }
  if (schema?.role !== 'schema') {
    issues.push(`${label} segment 1 must have role 'schema'`)
  }
  for (const [index, segment] of namespace.entries()) {
    issues.push(...identifierIssues(segment.identifier, `${label} segment ${index}`))
  }
  if (!expectedDatabase) {
    issues.push('Executing PostgreSQL profile has no canonical database segment')
  } else if (
    database?.role === 'database' &&
    database.identifier.comparisonKey !== expectedDatabase.comparisonKey
  ) {
    issues.push(
      `${label} database ${JSON.stringify(database.identifier.spelling)} does not match executing database ${JSON.stringify(expectedDatabase.spelling)}`,
    )
  }
  return issues
}

/** Collects deterministic PostgreSQL target/reference validation issues for one step. */
function stepTargetIssues(
  step: MigrationStep,
  expectedDatabase: CanonicalIdentifier | undefined,
): string[] {
  const issues: string[] = []
  const namespace =
    step.target.kind === 'namespace'
      ? step.target.namespace
      : step.target.relation.namespace
  issues.push(
    ...namespaceIssues(namespace, expectedDatabase, 'Migration target namespace'),
  )
  if (step.target.kind !== 'namespace') {
    issues.push(...identifierIssues(step.target.relation.relation, 'Migration relation'))
  }
  if (step.target.kind === 'column') {
    issues.push(...identifierIssues(step.target.column, 'Migration column'))
  } else if (step.target.kind === 'index') {
    issues.push(...identifierIssues(step.target.index, 'Migration index'))
  }
  if (step.kind === 'add_foreign_key') {
    issues.push(
      ...namespaceIssues(
        step.references.relation.namespace,
        expectedDatabase,
        'Foreign-key reference namespace',
      ),
      ...identifierIssues(step.references.relation.relation, 'Referenced relation'),
      ...identifierIssues(step.references.column, 'Referenced column'),
    )
  }
  if (step.kind === 'create_index') {
    for (const column of step.columns) {
      issues.push(...identifierIssues(column, 'Indexed column'))
    }
  }
  return issues
}

/** Returns the relation addressed by a relation/member step. */
function stepRelation(step: MigrationStep): CanonicalRelationIdentity | undefined {
  return step.target.kind === 'namespace' ? undefined : step.target.relation
}

/** Compares canonical namespaces without relying on dotted encodings. */
function sameNamespace(
  left: CanonicalRelationIdentity['namespace'],
  right: CanonicalRelationIdentity['namespace'],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (segment, index) =>
        segment.role === right[index]?.role &&
        segment.identifier.comparisonKey === right[index]?.identifier.comparisonKey,
    )
  )
}

/** Adds deterministic dependency edges and topologically orders action drafts. */
function orderActions(
  drafts: readonly ActionDraft[],
  planned: PlannedMigration,
): { ordered: ActionDraft[]; issues: MigrationCapabilityIssue[] } {
  const dependencies = drafts.map(() => new Set<number>())
  const identities = planned.identities
  const dependsOn = (action: number, dependency: number) => {
    if (action !== dependency) dependencies[action]!.add(dependency)
  }

  for (let action = 0; action < drafts.length; action++) {
    const current = drafts[action]!
    const relation = stepRelation(current.step)
    for (let candidate = 0; candidate < drafts.length; candidate++) {
      const other = drafts[candidate]!
      if (
        other.step.kind === 'ensure_namespace' &&
        relation &&
        sameNamespace(other.step.target.namespace, relation.namespace)
      ) {
        dependsOn(action, candidate)
      }
      if (
        other.step.kind === 'create_table' &&
        relation &&
        current.step.kind !== 'create_table' &&
        current.step.kind !== 'drop_table' &&
        identities.equals(other.step.target.relation, relation)
      ) {
        dependsOn(action, candidate)
      }
      if (
        current.step.kind === 'add_foreign_key' &&
        other.step.kind === 'create_table' &&
        identities.equals(other.step.target.relation, current.step.references.relation)
      ) {
        dependsOn(action, candidate)
      }
      if (
        current.step.kind === 'create_index' &&
        other.step.kind === 'add_column' &&
        identities.equals(current.step.target.relation, other.step.target.relation)
      ) {
        const addedColumn = other.step.target.column
        if (
          current.step.columns.some(
            (column) => column.comparisonKey === addedColumn.comparisonKey,
          )
        ) {
          dependsOn(action, candidate)
        }
      }
      if (
        current.step.kind === 'add_foreign_key' &&
        other.step.kind === 'add_column' &&
        ((identities.equals(current.step.target.relation, other.step.target.relation) &&
          current.step.target.column.comparisonKey ===
            other.step.target.column.comparisonKey) ||
          (identities.equals(
            current.step.references.relation,
            other.step.target.relation,
          ) &&
            current.step.references.column.comparisonKey ===
              other.step.target.column.comparisonKey))
      ) {
        dependsOn(action, candidate)
      }
      if (
        current.step.kind === 'drop_column' &&
        other.step.kind === 'drop_index' &&
        identities.equals(current.step.target.relation, other.step.target.relation)
      ) {
        const relation = current.step.target.relation
        const column = current.step.target.column.spelling
        const indexName = other.step.target.index.spelling
        const table = planned.planningCatalog.tables.find((entry) =>
          identities.equals(entry.identity, relation),
        )
        const index = table?.indexes.find(
          (entry) => entry.name === indexName && entry.columns.includes(column),
        )
        if (index) dependsOn(action, candidate)
      }
      if (current.step.kind === 'drop_table' && other.step.kind === 'drop_table') {
        const parentRelation = current.step.target.relation
        const childRelation = other.step.target.relation
        const child = planned.planningCatalog.tables.find((entry) =>
          identities.equals(entry.identity, childRelation),
        )
        if (
          child?.foreignKeys.some((foreignKey) =>
            identities.equals(foreignKey.referencedRelation, parentRelation),
          )
        ) {
          dependsOn(action, candidate)
        }
      }
    }
  }

  const remaining = dependencies.map((edges) => new Set(edges))
  const available = drafts
    .map((_, index) => index)
    .filter((index) => remaining[index]!.size === 0)
  const ordered: ActionDraft[] = []
  while (available.length > 0) {
    available.sort(
      (left, right) => drafts[left]!.sourceStepIndex - drafts[right]!.sourceStepIndex,
    )
    const next = available.shift()!
    ordered.push(drafts[next]!)
    for (let index = 0; index < remaining.length; index++) {
      if (!remaining[index]!.delete(next) || remaining[index]!.size !== 0) continue
      if (!ordered.includes(drafts[index]!)) available.push(index)
    }
  }

  if (ordered.length === drafts.length) return { ordered, issues: [] }
  let nextIndex = 0
  const indexes = new Array<number | undefined>(drafts.length)
  const lowLinks = new Array<number>(drafts.length)
  const stack: number[] = []
  const onStack = new Set<number>()
  const cycles: number[][] = []

  const visit = (node: number) => {
    indexes[node] = nextIndex
    lowLinks[node] = nextIndex++
    stack.push(node)
    onStack.add(node)
    for (const dependency of dependencies[node]!) {
      if (indexes[dependency] === undefined) {
        visit(dependency)
        lowLinks[node] = Math.min(lowLinks[node]!, lowLinks[dependency]!)
      } else if (onStack.has(dependency)) {
        lowLinks[node] = Math.min(lowLinks[node]!, indexes[dependency]!)
      }
    }
    if (lowLinks[node] !== indexes[node]) return
    const component: number[] = []
    let member: number
    do {
      member = stack.pop()!
      onStack.delete(member)
      component.push(member)
    } while (member !== node)
    if (
      component.length > 1 ||
      (component.length === 1 && dependencies[node]!.has(node))
    ) {
      cycles.push(component)
    }
  }

  for (let node = 0; node < drafts.length; node++) {
    if (indexes[node] === undefined) visit(node)
  }
  const issues = cycles.map((cycle) => {
    const sourceStepIndexes = cycle
      .map((index) => drafts[index]!.sourceStepIndex)
      .sort((left, right) => left - right)
    return {
      code: 'unsupported_dependency_cycle' as const,
      message: `PostgreSQL cannot safely order migration steps ${sourceStepIndexes.join(', ')} without CASCADE`,
      sourceStepIndexes,
    }
  })
  return {
    ordered: [],
    issues,
  }
}

const ISSUE_ORDER: Record<MigrationCapabilityIssue['code'], number> = {
  profile_mismatch: 0,
  missing_desired_table: 1,
  invalid_target: 2,
  compile_failure: 3,
  unsupported_dependency_cycle: 4,
}

/** Purely lowers and compiles a complete PostgreSQL Migration Plan. */
export function lowerPostgresMigrationPlan(
  planned: PlannedMigration,
  expectedProfile: MigrationSemanticProfile,
): MigrationLoweringResult {
  const issues = profileIssues(planned, expectedProfile)
  const drafts: ActionDraft[] = []
  const preconditions: MigrationPrecondition[] = []
  let expectedDatabase: CanonicalIdentifier | undefined
  try {
    const namespace = planned.identities.resolveNamespace(
      expectedProfile.namespaceContext.writableDefault,
    )
    const database = namespace[0]
    if (namespace.length === 2 && database?.role === 'database') {
      expectedDatabase = database.identifier
    }
  } catch {
    // Profile issues and per-step invalid-target issues report malformed context.
  }

  planned.plan.steps.forEach((step, sourceStepIndex) => {
    const invalidTargets = stepTargetIssues(step, expectedDatabase)
    for (const message of invalidTargets) {
      issues.push({
        code: 'invalid_target',
        message,
        sourceStepIndexes: [sourceStepIndex],
      })
    }
    if (
      step.kind === 'create_table' &&
      !planned.desiredTables.has(step.target.relation)
    ) {
      issues.push({
        code: 'missing_desired_table',
        message: `Cannot create table ${planned.identities.format(step.target.relation)}: lowered CreateTableAst not found`,
        sourceStepIndexes: [sourceStepIndex],
      })
    }
    if (
      invalidTargets.length > 0 ||
      issues.some(
        (issue) =>
          issue.code === 'missing_desired_table' &&
          issue.sourceStepIndexes[0] === sourceStepIndex,
      )
    )
      return
    try {
      const ast = stepToAst(step, planned)
      if (!ast) {
        const relation = stepRelation(step)
        issues.push({
          code: 'missing_desired_table',
          message: `Cannot create table ${relation ? planned.identities.format(relation) : 'unknown target'}: lowered CreateTableAst not found`,
          sourceStepIndexes: [sourceStepIndex],
        })
        return
      }
      const statement = compilePostgres(ast)
      drafts.push({ step, sourceStepIndex, statement })
      if (step.kind === 'set_not_null') {
        preconditions.push({
          kind: 'column_has_no_nulls',
          relation: step.target.relation,
          column: step.target.column.spelling,
          sourceStepIndexes: [sourceStepIndex],
        })
      }
    } catch (cause) {
      issues.push({
        code: 'compile_failure',
        message:
          cause instanceof Error
            ? `Cannot compile migration step ${sourceStepIndex}: ${cause.message}`
            : `Cannot compile migration step ${sourceStepIndex}`,
        sourceStepIndexes: [sourceStepIndex],
      })
    }
  })

  const ordered = orderActions(drafts, planned)
  issues.push(...ordered.issues)
  issues.sort(
    (left, right) =>
      (left.sourceStepIndexes[0] ?? -1) - (right.sourceStepIndexes[0] ?? -1) ||
      ISSUE_ORDER[left.code] - ISSUE_ORDER[right.code] ||
      (left.message < right.message ? -1 : left.message > right.message ? 1 : 0),
  )
  if (issues.length > 0) return { issues }

  const actions: MigrationAction[] = ordered.ordered.map((draft) => ({
    sourceStepIndexes: [draft.sourceStepIndex],
    transaction: 'required',
    statements: [draft.statement],
  }))
  return {
    program: {
      atomicity: 'plan-atomic',
      preconditions,
      actions,
    },
  }
}

/** Quotes a PostgreSQL identifier. */
function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/** Creates a structured execution failure while preserving the primary cause. */
function executionError(options: {
  cause: unknown
  stage: MigrationExecutionStage
  outcome: 'unchanged' | 'rolledBack' | 'applied' | 'unknown'
  retryable: boolean
  actionIndex?: number
  sourceStepIndexes?: readonly number[]
  cleanupFailures?: readonly MigrationCleanupFailure[]
}): MigrationError {
  const { cause } = options
  const structured = cause instanceof MigrationError ? cause : undefined
  const cleanupFailures = [
    ...(structured?.cleanupFailures ?? []),
    ...(options.cleanupFailures ?? []),
  ]
  return new MigrationError({
    message: cause instanceof Error ? cause.message : 'Migration failed',
    cause:
      cause instanceof MigrationError && cause.cause !== undefined ? cause.cause : cause,
    stage: structured?.stage ?? options.stage,
    outcome: options.outcome,
    retryable:
      options.outcome === 'unknown'
        ? false
        : (structured?.retryable ?? options.retryable),
    ...(options.actionIndex === undefined
      ? structured?.actionIndex === undefined
        ? {}
        : { actionIndex: structured.actionIndex }
      : { actionIndex: options.actionIndex }),
    ...(options.sourceStepIndexes === undefined
      ? cause instanceof MigrationError && cause.sourceStepIndexes !== undefined
        ? { sourceStepIndexes: cause.sourceStepIndexes }
        : {}
      : { sourceStepIndexes: options.sourceStepIndexes }),
    ...(cleanupFailures.length ? { cleanupFailures } : {}),
  })
}

class MigrationCancellationError extends Error {
  constructor(
    message: string,
    readonly stage: MigrationExecutionStage,
    readonly cleanupFailures: readonly MigrationCleanupFailure[] = [],
  ) {
    super(message)
  }
}

class MigrationLockTimeoutError extends MigrationCancellationError {}
class MigrationSignalAbortedError extends MigrationCancellationError {}

type CancellationState = {
  cancelled: boolean
}

const MIGRATION_LOCK_POLL_INTERVAL_MS = 100
const MIGRATION_SESSION_CALL_TIMEOUT_MS = 5_000

/** Cancels and drains an in-flight session operation without leaking its rejection. */
async function cancelSession(
  options: MigrationRuntimeOptions,
  state: CancellationState,
  inFlight?: Promise<unknown>,
): Promise<MigrationCleanupFailure[]> {
  state.cancelled = true
  options.discard()
  const cleanupFailures: MigrationCleanupFailure[] = []
  let cancelSucceeded = true
  try {
    await options.cancel()
  } catch (cause) {
    cancelSucceeded = false
    cleanupFailures.push({ stage: 'sessionCleanup', cause })
  }
  const settled = inFlight?.then(
    () => undefined,
    () => undefined,
  )
  if (cancelSucceeded) await settled
  return cleanupFailures
}

/** Races one physical-session operation against cancellation and an optional deadline. */
async function runCancellable<T>(options: {
  runtime: MigrationRuntimeOptions
  state: CancellationState
  operation: () => Promise<T>
  stage: MigrationExecutionStage
  timeoutMs?: number
  timeoutMessage?: string
}): Promise<T> {
  const { runtime, state, stage, timeoutMs } = options
  if (runtime.signal?.aborted) {
    const cleanupFailures = await cancelSession(runtime, state)
    throw new MigrationSignalAbortedError(
      'Migration execution was aborted',
      stage,
      cleanupFailures,
    )
  }
  const operation = options.operation()

  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const interrupted = new Promise<'timeout' | 'abort'>((resolve) => {
    if (timeoutMs !== undefined) timer = setTimeout(() => resolve('timeout'), timeoutMs)
    if (runtime.signal) {
      abort = () => resolve('abort')
      runtime.signal.addEventListener('abort', abort, { once: true })
    }
  })
  const settled = operation.then(
    (value) => ({ kind: 'value' as const, value }),
    (cause) => ({ kind: 'error' as const, cause }),
  )
  const result = await Promise.race([settled, interrupted])
  if (timer) clearTimeout(timer)
  if (abort) runtime.signal?.removeEventListener('abort', abort)
  if (result === 'timeout' || result === 'abort') {
    const cleanupFailures = await cancelSession(runtime, state, operation)
    if (result === 'timeout') {
      throw new MigrationLockTimeoutError(
        options.timeoutMessage ??
          `Timed out acquiring the migration advisory lock after ${runtime.lockTimeoutMs}ms`,
        stage,
        cleanupFailures,
      )
    }
    throw new MigrationSignalAbortedError(
      'Migration execution was aborted',
      stage,
      cleanupFailures,
    )
  }
  if (result.kind === 'error') throw result.cause
  return result.value
}

/** Cancels immediately when a deadline or signal is observed between SQL calls. */
async function stopCancelled(
  options: MigrationRuntimeOptions,
  state: CancellationState,
  stage: MigrationExecutionStage,
  timeout: boolean,
): Promise<never> {
  const cleanupFailures = await cancelSession(options, state)
  if (timeout) {
    throw new MigrationLockTimeoutError(
      options.lockTimeoutMs === 0
        ? 'Migration advisory lock was not available after one no-wait try'
        : `Timed out acquiring the migration advisory lock after ${options.lockTimeoutMs}ms`,
      stage,
      cleanupFailures,
    )
  }
  throw new MigrationSignalAbortedError(
    'Migration execution was aborted',
    stage,
    cleanupFailures,
  )
}

/** Acquires the stable session advisory lock with a finite monotonic deadline. */
async function acquireCoordination(
  options: MigrationRuntimeOptions,
  state: CancellationState,
): Promise<void> {
  createMigrationCoordinationScope(options.databaseIdentity, options.applicationId)
  const deadline = performance.now() + options.lockTimeoutMs
  let firstAttempt = true
  while (true) {
    if (options.signal?.aborted) {
      await stopCancelled(options, state, 'lock', false)
    }
    if (!firstAttempt && performance.now() >= deadline) {
      await stopCancelled(options, state, 'lock', true)
    }
    const remaining = Math.max(0, deadline - performance.now())
    const [row] = await runCancellable({
      runtime: options,
      state,
      stage: 'lock',
      timeoutMs:
        options.lockTimeoutMs === 0
          ? MIGRATION_SESSION_CALL_TIMEOUT_MS
          : Math.min(MIGRATION_SESSION_CALL_TIMEOUT_MS, remaining),
      timeoutMessage: `Timed out waiting ${MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for a migration lock attempt response`,
      operation: () =>
        options.executor.execute({
          sql: `select pg_try_advisory_lock(${MIGRATE_ADVISORY_LOCK_CLASS}, ${MIGRATE_ADVISORY_LOCK_ID}) as "locked"`,
          params: [],
        }),
    })
    firstAttempt = false
    if (typeof row !== 'object' || row === null || !('locked' in row)) {
      throw new Error('PostgreSQL did not return a migration advisory lock result')
    }
    if (row.locked === true) return
    if (row.locked !== false) {
      throw new Error('PostgreSQL returned an invalid migration advisory lock result')
    }
    if (options.signal?.aborted) {
      await stopCancelled(options, state, 'lock', false)
    }
    const waitRemaining = deadline - performance.now()
    if (waitRemaining <= 0) {
      await stopCancelled(options, state, 'lock', true)
    }
    await runCancellable({
      runtime: options,
      state,
      stage: 'lock',
      timeoutMs: waitRemaining,
      operation: () =>
        new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(MIGRATION_LOCK_POLL_INTERVAL_MS, waitRemaining)),
        ),
    })
  }
}

/** Releases and verifies the stable session advisory lock. */
async function releaseCoordination(options: MigrationRuntimeOptions): Promise<void> {
  const [row] = await options.executor.execute({
    sql: `select pg_advisory_unlock(${MIGRATE_ADVISORY_LOCK_CLASS}, ${MIGRATE_ADVISORY_LOCK_ID}) as "unlocked"`,
    params: [],
  })
  if (
    typeof row !== 'object' ||
    row === null ||
    !('unlocked' in row) ||
    row.unlocked !== true
  ) {
    throw new Error('PostgreSQL did not verify migration advisory lock release')
  }
}

/** Evaluates one semantic precondition in the authoritative transaction. */
async function assertPrecondition(
  options: MigrationRuntimeOptions,
  precondition: MigrationPrecondition,
): Promise<void> {
  const schema = schemaFromNamespace(precondition.relation.namespace)
  const relation = `${quoteIdent(schema)}.${quoteIdent(precondition.relation.relation.spelling)}`
  const [row] = await options.executor.execute({
    sql: `select count(*)::int as count from ${relation} where ${quoteIdent(precondition.column)} is null`,
    params: [],
  })
  const count = Number((row as { count?: unknown } | undefined)?.count ?? 0)
  if (count > 0) {
    throw new Error(
      `Cannot set column '${schema}.${precondition.relation.relation.spelling}.${precondition.column}' as NOT NULL - column has NULL values`,
    )
  }
}

/**
 * Runs one PostgreSQL migration under coordination and an authoritative repeatable-read
 * transaction. Commit acknowledgement is a hard uncertainty boundary: it is never
 * followed by rollback or compensation.
 */
export async function executePostgresMigration(
  options: MigrationRuntimeOptions,
): Promise<{ outcome: 'applied' | 'unchanged' }> {
  let lockAcquired = false
  const cancellation: CancellationState = { cancelled: false }
  try {
    await acquireCoordination(options, cancellation)
    lockAcquired = true
  } catch (cause) {
    const knownSafeFailure =
      cause instanceof MigrationLockTimeoutError ||
      cause instanceof MigrationSignalAbortedError
    if (!knownSafeFailure) options.discard()
    throw executionError({
      cause,
      stage: 'lock',
      outcome: 'unchanged',
      retryable: knownSafeFailure,
      cleanupFailures:
        cause instanceof MigrationCancellationError ? cause.cleanupFailures : [],
    })
  }

  let transactionOpen = false
  let ddlStarted = false
  let rollbackAcknowledged = false
  let committed = false
  let primary:
    | {
        cause: unknown
        stage: MigrationExecutionStage
        actionIndex?: number
        sourceStepIndexes?: readonly number[]
      }
    | undefined
  const cleanupFailures: MigrationCleanupFailure[] = []

  try {
    try {
      await runCancellable({
        runtime: options,
        state: cancellation,
        stage: 'transaction',
        operation: () =>
          options.executor.run({
            sql: 'begin isolation level repeatable read',
            params: [],
          }),
      })
      transactionOpen = true
    } catch (cause) {
      options.discard()
      primary = {
        cause,
        stage: cause instanceof MigrationCancellationError ? cause.stage : 'transaction',
      }
      if (cause instanceof MigrationCancellationError) {
        cleanupFailures.push(...cause.cleanupFailures)
      }
    }

    let program
    if (!primary) {
      try {
        program = await runCancellable({
          runtime: options,
          state: cancellation,
          stage: 'introspection',
          operation: options.prepare,
        })
        if (program.atomicity !== 'plan-atomic') {
          throw new MigrationError({
            message: `Migration execution requires plan-atomic programs; received ${program.atomicity}`,
            stage: 'lowering',
            outcome: 'unchanged',
            retryable: false,
          })
        }
        const invalidAction = program.actions.find(
          (action) => action.transaction !== 'required',
        )
        if (invalidAction) {
          throw new MigrationError({
            message: `Plan-atomic PostgreSQL actions must require a transaction; received ${invalidAction.transaction}`,
            stage: 'lowering',
            outcome: 'unchanged',
            retryable: false,
          })
        }
      } catch (cause) {
        primary = {
          cause,
          stage:
            cause instanceof MigrationCancellationError
              ? cause.stage
              : cause instanceof MigrationError && cause.stage !== undefined
                ? cause.stage
                : 'lowering',
        }
        if (cause instanceof MigrationCancellationError) {
          cleanupFailures.push(...cause.cleanupFailures)
        }
      }
    }

    if (!primary && program) {
      for (const precondition of program.preconditions) {
        try {
          await runCancellable({
            runtime: options,
            state: cancellation,
            stage: 'precondition',
            operation: () => assertPrecondition(options, precondition),
          })
        } catch (cause) {
          primary = {
            cause,
            stage:
              cause instanceof MigrationCancellationError ? cause.stage : 'precondition',
            sourceStepIndexes: precondition.sourceStepIndexes,
          }
          if (cause instanceof MigrationCancellationError) {
            cleanupFailures.push(...cause.cleanupFailures)
          }
          break
        }
      }
    }

    if (!primary && program) {
      for (let actionIndex = 0; actionIndex < program.actions.length; actionIndex++) {
        const action = program.actions[actionIndex]!
        try {
          ddlStarted = true
          for (const statement of action.statements) {
            await runCancellable({
              runtime: options,
              state: cancellation,
              stage: 'ddl',
              operation: () => options.executor.run(statement),
            })
          }
        } catch (cause) {
          primary = {
            cause,
            stage: 'ddl',
            actionIndex,
            sourceStepIndexes: action.sourceStepIndexes,
          }
          if (cause instanceof MigrationCancellationError) {
            cleanupFailures.push(...cause.cleanupFailures)
          }
          break
        }
      }
    }

    if (!primary) {
      try {
        await runCancellable({
          runtime: options,
          state: cancellation,
          stage: 'commit',
          operation: () => options.executor.run({ sql: 'commit', params: [] }),
        })
        transactionOpen = false
        committed = true
      } catch (cause) {
        transactionOpen = false
        options.discard()
        primary = {
          cause,
          stage: cause instanceof MigrationCancellationError ? cause.stage : 'commit',
        }
        if (cause instanceof MigrationCancellationError) {
          cleanupFailures.push(...cause.cleanupFailures)
        }
      }
    } else if (transactionOpen && !cancellation.cancelled) {
      try {
        await runCancellable({
          runtime: options,
          state: cancellation,
          stage: 'rollback',
          operation: () => options.executor.run({ sql: 'rollback', params: [] }),
        })
        transactionOpen = false
        rollbackAcknowledged = true
      } catch (cause) {
        transactionOpen = false
        options.discard()
        cleanupFailures.push({ stage: 'rollback', cause })
        if (cause instanceof MigrationCancellationError) {
          cleanupFailures.push(...cause.cleanupFailures)
        }
      }
    }
  } finally {
    if (lockAcquired && !cancellation.cancelled) {
      try {
        await runCancellable({
          runtime: options,
          state: cancellation,
          stage: 'unlock',
          timeoutMs: MIGRATION_SESSION_CALL_TIMEOUT_MS,
          timeoutMessage: `Timed out waiting ${MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for migration advisory lock release verification`,
          operation: () => releaseCoordination(options),
        })
      } catch (cause) {
        options.discard()
        cleanupFailures.push({ stage: 'unlock', cause })
        if (cause instanceof MigrationCancellationError) {
          cleanupFailures.push(...cause.cleanupFailures)
        }
      }
    }
  }

  if (primary) {
    const outcome =
      primary.stage === 'commit'
        ? 'unknown'
        : ddlStarted
          ? rollbackAcknowledged
            ? 'rolledBack'
            : 'unknown'
          : 'unchanged'
    throw executionError({
      ...primary,
      outcome,
      retryable:
        outcome !== 'unknown' && primary.cause instanceof MigrationCancellationError,
      cleanupFailures,
    })
  }

  if (cleanupFailures.length > 0) {
    const cause = cleanupFailures[0]!.cause
    throw executionError({
      cause,
      stage: 'unlock',
      outcome: committed && ddlStarted ? 'applied' : 'unchanged',
      retryable: false,
      cleanupFailures,
    })
  }

  return { outcome: committed && ddlStarted ? 'applied' : 'unchanged' }
}
