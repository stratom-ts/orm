import type { BaseIssue } from 'valibot'
import { getDotPath } from 'valibot'

import type { MigrationTarget } from '@/ddl/migrationPlan'
import type { MigrationCapabilityIssue } from '@/ddl/migrationProgram'
import type { Equals } from '@/types/equals'

// Symbol.for keeps the brand stable when two copies of Stratom are loaded.
const errorBrand = Symbol.for('stratom.error')

type Attempt<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: unknown }>

/** Settles an asynchronous operation without introducing another error boundary. */
async function attempt<T>(operation: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Settles a synchronous operation without introducing another error boundary. */
function attemptSync<T>(operation: () => T): Attempt<T> {
  try {
    return { ok: true, value: operation() }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Creates a tagged `Error` subclass with a fixed `_tag` discriminant.
 *
 * @example
 *   class NotFound extends TaggedError('NotFound')<{ id: string }> {}
 *   throw new NotFound({ id: '42' })
 *
 * @param tag - Discriminant string stored on instances as `_tag`
 *
 * @returns Error constructor that accepts optional payload fields
 */
function TaggedError<Tag extends string>(
  tag: Tag,
): new <A extends Record<string, unknown> = Record<string, unknown>>(
  ...args: Equals<A, Record<string, unknown>> extends true
    ? []
    : [
        args: {
          readonly [P in keyof A as P extends '_tag' ? never : P]: A[P]
        },
      ]
) => Error & { readonly _tag: Tag; toJSON(): Record<string, unknown> } & Readonly<A> {
  class BaseError extends Error {
    readonly _tag = tag

    toJSON(): Record<string, unknown> {
      return serializeError(this, new Set()) as Record<string, unknown>
    }

    /**
     * Creates a tagged error from payload fields.
     *
     * @param args - Payload fields assigned to the error.
     */
    constructor(args: Record<string, unknown> = {}) {
      const { message, cause, ...properties } = args
      super(
        typeof message === 'string' ? message : '',
        Object.hasOwn(args, 'cause') ? { cause } : undefined,
      )

      Object.assign(this, properties)

      Object.defineProperty(this, '_tag', {
        value: tag,
        enumerable: true,
        writable: false,
        configurable: false,
      })

      Object.defineProperty(this, errorBrand, {
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
      })
    }
  }
  BaseError.prototype.name = tag
  return BaseError as never
}

/** Serializes nested errors without losing their non-enumerable native diagnostics. */
function serializeError(value: unknown, seen: Set<object>): unknown {
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value === 'symbol') return value.toString()
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value)) return '[Circular]'

  seen.add(value)

  try {
    if (Array.isArray(value)) return serializeArray(value, seen)

    return serializeUnknownObject(value, seen)
  } finally {
    seen.delete(value)
  }
}

/** Serializes custom objects while honoring their JSON representation when available. */
function serializeUnknownObject(value: object, seen: Set<object>): unknown {
  if (value instanceof Error) return serializeObject(value, seen, true)

  const customJson = serializeCustomJson(value, seen)
  return customJson.serialized ? customJson.value : serializeObject(value, seen, false)
}

/** Recursively serializes array diagnostics without exposing array prototypes. */
function serializeArray(value: readonly unknown[], seen: Set<object>): unknown[] {
  const output: unknown[] = []
  for (const item of value) output.push(serializeError(item, seen))
  return output
}

/** Applies an explicit custom JSON serializer when it is safe to call. */
function serializeCustomJson(
  value: object,
  seen: Set<object>,
): { serialized: boolean; value?: unknown } {
  try {
    const toJSON = (value as { toJSON?: (this: object) => unknown }).toJSON

    if (typeof toJSON !== 'function') return { serialized: false }

    const serialized = toJSON.call(value)

    if (serialized === value) return { serialized: false }

    return { serialized: true, value: serializeError(serialized, seen) }
  } catch {
    return { serialized: false }
  }
}

/** Serializes fields separately so unusual diagnostic getters cannot mask the cause. */
function serializeObject(
  value: object,
  seen: Set<object>,
  isError: boolean,
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  const keys = Object.getOwnPropertyNames(value)

  for (const key of keys) {
    if (!isError || (key !== 'stack' && key !== 'cause'))
      serializeField(value, key, output, seen)
  }

  if (isError) serializeNativeError(value as Error, output, seen)

  return output
}

/** Reads and serializes one property without letting a getter abort traversal. */
function serializeField(
  value: object,
  key: string,
  output: Record<string, unknown>,
  seen: Set<object>,
): void {
  try {
    Object.defineProperty(output, key, {
      value: serializeError((value as Record<string, unknown>)[key], seen),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  } catch {
    // Diagnostic getters must not make error serialization fail.
  }
}

/** Adds native Error diagnostics that are non-enumerable by default. */
function serializeNativeError(
  value: Error,
  output: Record<string, unknown>,
  seen: Set<object>,
): void {
  try {
    output.name = value.name
  } catch {
    // Preserve the other diagnostics if a custom name getter throws.
  }

  serializeField(value, 'message', output, seen)
  serializeField(value, 'stack', output, seen)

  if ('cause' in value) serializeField(value, 'cause', output, seen)
}

/**
 * Error thrown when a migration cannot be applied safely.
 *
 * @example
 *   throw new MigrationError({ message: 'Cannot drop column with data' })
 */
class MigrationError extends TaggedError('MigrationError')<{
  message: string
  cause?: unknown
  defect?: true
  stage?: MigrationExecutionStage
  outcome?: MigrationExecutionOutcome
  retryable?: boolean
  actionIndex?: number
  completedActions?: readonly Readonly<{
    actionIndex: number
    sourceStepIndexes: readonly number[]
    target?: MigrationTarget
  }>[]
  rolledBackActions?: readonly Readonly<{
    actionIndex: number
    sourceStepIndexes: readonly number[]
    target?: MigrationTarget
  }>[]
  recovery?: Readonly<{
    target: Extract<MigrationTarget, { kind: 'index' }>
    operation: 'create' | 'drop'
    status: 'possibleResidue' | 'unknown'
    observedValidity?: 'valid' | 'invalid' | 'absent'
    requires: 'inspectAndReplan'
    repairPermission: 'repairInvalidIndex'
  }>
  sourceStepIndexes?: readonly number[]
  capabilityIssues?: readonly MigrationCapabilityIssue[]
  cleanupFailures?: readonly MigrationCleanupFailure[]
  preconditionFailure?: Readonly<{
    target: Extract<MigrationTarget, { kind: 'column' }>
    reason: 'contains_non_null_values' | 'verification_failed'
  }>
}> {}

/** Observable stage at which migration execution stopped. */
type MigrationExecutionStage =
  | 'lock'
  | 'transaction'
  | 'introspection'
  | 'planning'
  | 'permission'
  | 'lowering'
  | 'precondition'
  | 'ddl'
  | 'validation'
  | 'commit'
  | 'rollback'
  | 'unlock'
  | 'sessionCleanup'

/** Database effect known after a migration execution attempt. */
type MigrationExecutionOutcome =
  | 'unchanged'
  | 'rolledBack'
  | 'applied'
  | 'partial'
  | 'unknown'

/** Secondary cleanup failure retained without replacing the primary cause. */
type MigrationCleanupFailure = Readonly<{
  stage: 'rollback' | 'unlock' | 'sessionCleanup'
  cause: unknown
}>

/**
 * Error thrown when table/column metadata is invalid or incomplete.
 *
 * @example
 *   throw new SchemaError({ message: 'table() metadata is required' })
 */
class SchemaError extends TaggedError('SchemaError')<{
  message: string
}> {}

/**
 * Error thrown for invalid query use or an unavailable client.
 *
 * @example
 *   throw new QueryError({ message: 'Database has been closed' })
 */
class QueryError extends TaggedError('QueryError')<{
  message: string
  cause?: unknown
  cleanupFailures?: readonly MigrationCleanupFailure[]
}> {}

/** Portable meaning of a native database failure. */
type DriverErrorKind =
  | 'uniqueViolation'
  | 'foreignKeyViolation'
  | 'notNullViolation'
  | 'checkViolation'
  | 'transient'
  | 'unknown'

/** Fields a selected dialect can establish from native diagnostics. */
type DriverErrorClassification = Readonly<{
  kind: DriverErrorKind
  /** Potentially transient. Replay still requires caller-owned idempotency or recovery. */
  retryable: boolean
  constraint?: string
  table?: string
  columns?: readonly string[]
}>

type DriverErrorClassifier = (cause: unknown) => DriverErrorClassification

/** Error thrown by db0, a database driver, or the database while executing SQL. */
class DriverError extends TaggedError('DriverError')<
  {
    message: string
    dialect: string
    code?: string
    sql: string
    cause: unknown
    cleanupFailures?: readonly MigrationCleanupFailure[]
  } & DriverErrorClassification
> {}

/** Preserves any native rejection from one physical SQL call. */
function driverError(
  cause: unknown,
  dialect: string,
  sql: string,
  classify: DriverErrorClassifier,
  operation = 'database session SQL execution',
): DriverError {
  const code = readDriverCode(cause)

  return new DriverError({
    message: `${dialect} ${operation} failed`,
    dialect,
    ...(code === undefined ? {} : { code }),
    sql,
    cause,
    ...classify(cause),
  })
}

/** Reads optional native driver code without allowing a getter to replace the cause. */
function readDriverCode(cause: unknown): string | undefined {
  if ((typeof cause !== 'object' || cause === null) && typeof cause !== 'function')
    return undefined

  try {
    const property = (cause as Record<string, unknown>).code
    return typeof property === 'string' ? property : undefined
  } catch {
    return undefined
  }
}

/** Applies the selected member's policy only to a recognized driver failure. */
function classifyDriverError(failure: unknown, classify: DriverErrorClassifier): unknown {
  if (!isErrorTag(failure, 'DriverError')) return failure

  const classification = classify(failure.cause)

  if (
    failure.kind === classification.kind &&
    failure.retryable === classification.retryable &&
    failure.constraint === classification.constraint &&
    failure.table === classification.table &&
    (failure.columns === classification.columns ||
      (failure.columns?.length === classification.columns?.length &&
        failure.columns?.every(
          (column, index) => column === classification.columns?.[index],
        )))
  )
    return failure

  return new DriverError({
    message: failure.message,
    dialect: failure.dialect,
    ...(failure.code === undefined ? {} : { code: failure.code }),
    sql: failure.sql,
    cause: failure.cause,
    ...(failure.cleanupFailures ? { cleanupFailures: failure.cleanupFailures } : {}),
    ...classification,
  })
}

type ValidationOperation = 'insert' | 'update'

type ValidationErrorArgs = Readonly<{
  table: string
  operation: ValidationOperation
  issues: [BaseIssue<unknown>, ...BaseIssue<unknown>[]]
  cause?: unknown
}>

function formatValidationIssues(issues: ValidationErrorArgs['issues']): string {
  return issues
    .map((issue) => {
      const path = getDotPath(issue)
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
}

/**
 * Error thrown when insert or update payloads fail Valibot validation.
 *
 * @example
 *   throw new ValidationError({ table: 'users', operation: 'insert', issues })
 */
class ValidationError extends TaggedError('ValidationError')<{
  table: string
  operation: ValidationOperation
  issues: [BaseIssue<unknown>, ...BaseIssue<unknown>[]]
  message: string
  cause?: unknown
}> {
  constructor({ table, operation, issues, cause }: ValidationErrorArgs) {
    const context =
      operation === 'insert'
        ? `Invalid insert into "${table}"`
        : `Invalid update on "${table}"`

    super({
      table,
      operation,
      issues,
      message: `${context}: ${formatValidationIssues(issues)}`,
      ...(cause === undefined ? {} : { cause }),
    })
  }
}

/** Error thrown when an internal contract or invariant is violated. */
class InvariantError extends TaggedError('InvariantError')<{
  message: string
}> {
  /** Creates a structured invariant error with its diagnostic message. */
  constructor(message: string) {
    super({ message })
  }
}

/** Errors exposed by Stratom's public API. */
type StratomError =
  | SchemaError
  | ValidationError
  | QueryError
  | MigrationError
  | DriverError
  | InvariantError

const errorTags = new Set<StratomError['_tag']>([
  'SchemaError',
  'ValidationError',
  'QueryError',
  'MigrationError',
  'DriverError',
  'InvariantError',
])

/** Recognizes a Stratom error from either copy of the package. */
function isStratomError(error: unknown): error is StratomError {
  if (typeof error !== 'object' || error === null) return false

  try {
    const candidate = error as Record<PropertyKey, unknown>
    return (
      candidate[errorBrand] === true &&
      errorTags.has(candidate._tag as StratomError['_tag'])
    )
  } catch {
    return false
  }
}

/** Narrows a caught value to one Stratom error tag. */
function isErrorTag<T extends StratomError['_tag']>(
  error: unknown,
  tag: T,
): error is Extract<StratomError, { _tag: T }> {
  try {
    return isStratomError(error) && error._tag === tag
  } catch {
    return false
  }
}

export type {
  Attempt,
  MigrationExecutionStage,
  MigrationExecutionOutcome,
  MigrationCleanupFailure,
  DriverErrorKind,
  DriverErrorClassification,
  DriverErrorClassifier,
  ValidationOperation,
  StratomError,
}

export {
  attempt,
  attemptSync,
  TaggedError,
  MigrationError,
  SchemaError,
  QueryError,
  DriverError,
  driverError,
  classifyDriverError,
  ValidationError,
  InvariantError,
  isStratomError,
  isErrorTag,
}
