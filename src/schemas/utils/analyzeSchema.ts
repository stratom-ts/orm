// Transitional native analysis entry point while storage consumers migrate to facts.
export {
  analyzeSchema,
  withBigintConstraints,
  withNumberConstraints,
} from '@/internal/valibot/analyzeSchema'
export type { SchemaAnalysis, SchemaOutputKind } from '@/internal/valibot/analyzeSchema'
