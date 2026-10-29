import type { StorageFacts } from '@/storage/facts'
import type { AnySchema } from '@/types/schema'

import { analyzeSchema } from './analyzeSchema'
import type { SchemaAnalysis } from './analyzeSchema'

/** Extracts storage evidence through the same traversal used by current consumers. */
export function extractStorageFacts(schema: AnySchema): StorageFacts {
  return projectStorageFacts(analyzeSchema(schema))
}

/** Copies semantic evidence only. Native schema references remain inside this module. */
function projectStorageFacts(analysis: SchemaAnalysis): StorageFacts {
  const branches = analysis.composite?.branches.map(projectStorageFacts)
  const effectiveType = analysis.outputSchema?.type
  const singletonValue = (
    analysis.outputSchema as (AnySchema & { literal?: unknown }) | undefined
  )?.literal

  return {
    outputKind: analysis.outputKind,
    outputState: analysis.unresolvedTransformation
      ? 'unresolved'
      : analysis.outputKind || analysis.nullOnly
        ? 'known'
        : effectiveType === 'unknown' || effectiveType === 'any'
          ? 'unconstrained'
          : 'unsupported',
    nullable: analysis.nullable,
    allowsUndefined: analysis.allowsUndefined,
    outputMayBeUndefined: analysis.outputMayBeUndefined,
    omitOnInsert: analysis.omitOnInsert,
    schemaDefault:
      analysis.schemaDefault === undefined
        ? { kind: 'absent' }
        : typeof analysis.schemaDefault === 'function'
          ? { kind: 'factory' }
          : { kind: 'value', value: analysis.schemaDefault },
    stringConstraints: { ...analysis.stringConstraints },
    stringFormats: [...analysis.stringFormats],
    numberConstraints: { ...analysis.numberConstraints },
    bigintConstraints: { ...analysis.bigintConstraints },
    ...finiteChoiceEvidence(analysis, effectiveType),
    ...(effectiveType === 'literal' ? { singletonValue } : {}),
    finiteValues: analysis.finiteValues && [...analysis.finiteValues],
    composite:
      analysis.composite && branches
        ? {
            kind:
              analysis.composite.type === 'intersect' ? 'intersection' : 'alternatives',
            branches,
          }
        : undefined,
    jsonShape: outputJsonShape(analysis, branches),
    jsonOutputCompatible: analysis.jsonOutputCompatible,
    nullOnly: analysis.nullOnly,
  }
}

function finiteChoiceEvidence(
  analysis: SchemaAnalysis,
  effectiveType: string | undefined,
): Pick<StorageFacts, 'finiteEvidence' | 'finiteSourceValues'> {
  if (effectiveType === 'literal') return { finiteEvidence: 'singleton' }

  if (effectiveType === 'enum' || effectiveType === 'picklist')
    return {
      finiteEvidence: 'choice',
      finiteSourceValues: [
        ...(analysis.outputSchema as AnySchema & { options: readonly unknown[] }).options,
      ],
    }

  return { finiteEvidence: undefined }
}

function outputJsonShape(
  analysis: SchemaAnalysis,
  branches: readonly StorageFacts[] | undefined,
): StorageFacts['jsonShape'] {
  if (analysis.outputKind !== 'json') return undefined

  const effectiveType = analysis.outputSchema?.type

  if (
    effectiveType &&
    ['array', 'tuple', 'loose_tuple', 'strict_tuple', 'tuple_with_rest'].includes(
      effectiveType,
    )
  )
    return 'array'

  if (
    effectiveType &&
    ['object', 'loose_object', 'strict_object', 'object_with_rest', 'record'].includes(
      effectiveType,
    )
  )
    return 'object'

  const shapes = branches
    ?.filter((branch) => !branch.nullOnly)
    .map((branch) => branch.jsonShape)

  if (!shapes?.length) return undefined

  return shapes.every((shape) => shape === shapes[0]) ? shapes[0] : 'mixed'
}
