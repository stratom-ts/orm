// Transitional native analysis entry point while storage consumers migrate to facts.
export {
  analyzeSchema,
  withBigintConstraints,
  withNumberConstraints,
} from '@/schemas/valibot/analyzeSchema'
export type { SchemaAnalysis, SchemaOutputKind } from '@/schemas/valibot/analyzeSchema'
