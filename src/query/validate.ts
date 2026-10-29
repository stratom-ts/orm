import type { BaseIssue, ObjectEntries, ObjectSchema } from 'valibot'
import { object, optional, safeParse } from 'valibot'

import { getColumnMetadata } from '@/schemas'
import { extractStorageFacts } from '@/schemas/valibot/storageFacts'
import type { TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'
import { ValidationError } from '@/utils/error'

/**
 * Checks whether the outermost schema wrapper permits omission.
 *
 * @param schema - Column schema to inspect.
 */
function isDirectlyOmitOptionalSchema(schema: AnySchema): boolean {
  return (
    schema.type === 'optional' ||
    schema.type === 'exact_optional' ||
    schema.type === 'nullish'
  )
}

/**
 * Checks whether an insert may omit a column.
 *
 * @param schema - Column schema to inspect.
 */
function isInsertOptional(schema: AnySchema): boolean {
  if (extractStorageFacts(schema).omitOnInsert) return true

  const meta = getColumnMetadata(schema)

  if (!meta) return false

  const generation = meta.generation

  if (generation?.kind === 'identity' && generation.mode === 'byDefault') {
    return true
  }

  if (meta.databaseDefault !== undefined) return true

  return false
}

/** Rejects undefined values for columns whose schema requires an insert value. */
function assertDefinedInsertValue(
  tableName: string,
  row: Record<string, unknown>,
  columnName: string,
  value: unknown,
  schema: AnySchema | undefined,
): void {
  if (value !== undefined || schema === undefined) return
  if (isInsertOptional(schema)) return

  throw new ValidationError({
    table: tableName,
    operation: 'insert',
    issues: [
      validationIssue(
        value,
        'undefined',
        'defined value',
        'undefined',
        `column "${columnName}" cannot be undefined`,
        columnPath(row, columnName, 'value'),
      ),
    ],
  })
}

/**
 * Checks whether the database always generates a column value.
 *
 * @param schema - Column schema to inspect.
 */
function isAlwaysGenerated(schema: AnySchema): boolean {
  const meta = getColumnMetadata(schema)
  const generation = meta?.generation
  return (
    (generation?.kind === 'identity' && generation.mode === 'always') ||
    generation?.kind === 'computed'
  )
}

/**
 * Builds a Valibot object schema matching {@link InferInsert} rules:
 * always-generated omitted; byDefault / default / optional / nullish optional;
 * bare nullable stays required (accepts null).
 *
 * @example
 *   const schema = buildInsertSchema(User)
 *   safeParse(schema, { name: 'Alice' })
 *
 * @param handle - Table handle to derive the insert schema from.
 *
 * @returns Valibot object schema for insert validation
 */
export function buildInsertSchema(
  handle: TableHandle,
): ObjectSchema<ObjectEntries, undefined> {
  const entries = handle.getSchema().entries as Record<string, AnySchema>
  const insertEntries: ObjectEntries = {}

  for (const [name, columnSchema] of Object.entries(entries)) {
    if (isAlwaysGenerated(columnSchema)) continue

    if (isInsertOptional(columnSchema)) {
      insertEntries[name] = isDirectlyOmitOptionalSchema(columnSchema)
        ? columnSchema
        : optional(columnSchema)
    } else {
      // bare nullable and required columns stay as-is (nullable accepts null)
      insertEntries[name] = columnSchema
    }
  }

  return object(insertEntries)
}

/**
 * Builds a Valibot object schema matching {@link InferUpdate} rules:
 * partial patch; omits readonly and always-generated columns.
 *
 * @example
 *   const schema = buildUpdateSchema(User)
 *   safeParse(schema, { name: 'Bob' })
 *
 * @param handle - Table handle to derive the update schema from.
 *
 * @returns Valibot object schema for update patch validation
 */
export function buildUpdateSchema(
  handle: TableHandle,
): ObjectSchema<ObjectEntries, undefined> {
  const entries = handle.getSchema().entries as Record<string, AnySchema>
  const updateEntries: ObjectEntries = {}

  for (const [name, columnSchema] of Object.entries(entries)) {
    if (isAlwaysGenerated(columnSchema)) continue

    const meta = getColumnMetadata(columnSchema)

    if (meta?.readonly) continue

    // All updatable fields are optional patches (including bare nullable)
    updateEntries[name] = isDirectlyOmitOptionalSchema(columnSchema)
      ? columnSchema
      : optional(columnSchema)
  }

  return object(updateEntries)
}

function validationIssue(
  input: unknown,
  type: string,
  expected: string,
  received: string,
  message: string,
  path?: BaseIssue<unknown>['path'],
): BaseIssue<unknown> {
  return {
    kind: 'schema',
    type,
    input,
    expected,
    received,
    message,
    ...(path ? { path } : {}),
  }
}

function columnPath(
  input: Record<string, unknown>,
  key: string,
  origin: 'key' | 'value',
): NonNullable<BaseIssue<unknown>['path']> {
  return [{ type: 'object', origin, input, key, value: input[key] }]
}

function receivedType(input: unknown): string {
  return input === null ? 'null' : Array.isArray(input) ? 'Array' : typeof input
}

function assertObjectInput(
  table: string,
  operation: 'insert' | 'update',
  input: unknown,
): asserts input is Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) return

  const noun = operation === 'insert' ? 'row' : 'patch'
  throw new ValidationError({
    table,
    operation,
    issues: [
      validationIssue(
        input,
        'object',
        'Object',
        receivedType(input),
        `expected a plain object ${noun}`,
      ),
    ],
  })
}

/**
 * Validates a single insert row; throws {@link ValidationError} on failure.
 *
 * @example
 *   const cleaned = validateInsertRow(User, { name: 'Alice', email: 'a@b.com' })
 *
 * @param handle - Table handle for schema derivation.
 * @param row - Raw row object to validate.
 *
 * @returns Cleaned row with only insertable columns
 *
 * @throws ValidationError - When the row fails validation
 */
export function validateInsertRow(
  handle: TableHandle,
  row: unknown,
): Record<string, unknown> {
  assertObjectInput(handle.getTableMetadata().name, 'insert', row)
  const entries = handle.getSchema().entries as Record<string, AnySchema>
  const schema = buildInsertSchema(handle)
  const allowed = new Set(Object.keys(schema.entries))
  assertInsertableKeys(handle, row, entries, allowed)
  const result = safeParse(schema, row)

  if (!result.success)
    throw new ValidationError({
      table: handle.getTableMetadata().name,
      operation: 'insert',
      issues: result.issues,
    })

  // Keep only provided keys; omitted defaults remain SQL DEFAULT.
  const cleaned: Record<string, unknown> = {}
  for (const key of Object.keys(row)) {
    if (key in (result.output as object)) {
      cleaned[key] = (result.output as Record<string, unknown>)[key]
    }
  }

  // Include parsed defaults from optional schemas that produced values.
  return includeParsedDefaults(result, cleaned)
}

function assertInsertableKeys(
  handle: TableHandle,
  row: Record<string, unknown>,
  entries: Record<string, AnySchema>,
  allowed: Set<string>,
): void {
  const table = handle.getTableMetadata().name
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) {
      throw new ValidationError({
        table,
        operation: 'insert',
        issues: [
          validationIssue(
            row,
            'object',
            'known insertable column',
            key,
            `unknown or non-insertable column "${key}"`,
            columnPath(row, key, 'key'),
          ),
        ],
      })
    }

    assertDefinedInsertValue(table, row, key, row[key], entries[key])
  }
}

/** Adds parsed schema defaults without replacing explicitly supplied insert values. */
function includeParsedDefaults(
  result: {
    readonly typed: true
    readonly success: true
    readonly output: { [x: string]: unknown; [x: number]: unknown }
    readonly issues: undefined
  },
  cleaned: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(result.output as object)) {
    if (value !== undefined && !(key in cleaned)) {
      cleaned[key] = value
    }
  }

  return cleaned
}

/**
 * Validates an update patch; throws {@link ValidationError} on failure.
 * Rejects empty patches and unknown keys via schema parse.
 *
 * @example
 *   const cleaned = validateUpdatePatch(User, { name: 'Bob' })
 *
 * @param handle - Table handle for schema derivation.
 * @param patch - Raw patch object to validate.
 *
 * @returns Cleaned patch with only updatable columns
 *
 * @throws ValidationError - When the patch fails validation
 */
export function validateUpdatePatch(
  handle: TableHandle,
  patch: unknown,
): Record<string, unknown> {
  return validateUpdatePatchWithStructuredValues(handle, patch, () => false)
}

/** Validates an update patch while preserving caller-owned structured values. */
export function validateUpdatePatchWithStructuredValues(
  handle: TableHandle,
  patch: unknown,
  isStructuredValue: (value: unknown) => boolean,
): Record<string, unknown> {
  assertObjectInput(handle.getTableMetadata().name, 'update', patch)
  const schema = buildUpdateSchema(handle)
  const authoredPatch = patch
  const literalPatch = Object.fromEntries(
    Object.entries(authoredPatch).filter(([, value]) => !isStructuredValue(value)),
  )

  const result = safeParse(schema, literalPatch)

  if (!result.success)
    throw new ValidationError({
      table: handle.getTableMetadata().name,
      operation: 'update',
      issues: result.issues,
    })

  const allowed = new Set(Object.keys(schema.entries))
  assertUpdatableKeys(handle, patch, allowed)

  const output = result.output as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}
  // Preserve authored patch order while retaining structured values for their caller.
  for (const [key, value] of Object.entries(authoredPatch)) {
    const cleanedValue = isStructuredValue(value) ? value : output[key]

    if (cleanedValue !== undefined) cleaned[key] = cleanedValue
  }

  if (Object.keys(cleaned).length === 0) {
    throw new ValidationError({
      table: handle.getTableMetadata().name,
      operation: 'update',
      issues: [
        validationIssue(
          patch,
          'object',
          'non-empty patch',
          'empty object',
          'patch must include at least one column',
        ),
      ],
    })
  }

  return cleaned
}

function assertUpdatableKeys(
  handle: TableHandle,
  patch: Record<string, unknown>,
  allowed: Set<string>,
): void {
  const table = handle.getTableMetadata().name
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      throw new ValidationError({
        table,
        operation: 'update',
        issues: [
          validationIssue(
            patch,
            'object',
            'known updatable column',
            key,
            `unknown or non-updatable column "${key}"`,
            columnPath(patch, key, 'key'),
          ),
        ],
      })
    }
  }
}
