# Internal storage facts

`src/storage/facts.ts` describes logical storage evidence without validation-library types or native schema references.
`src/providers/valibot` owns the native analysis traversal and projects its result into these facts.
Projection does not validate values or execute defaults, fallbacks, transformations, or mapping hooks.
Singleton assertions and finite choices remain distinct even when they describe the same one value.
Defaults distinguish absence, a known value (including null), and an unevaluated factory.

The extraction is additive. Existing consumers still use the native analysis representation through `src/schemas/utils/analyzeSchema.ts`.
Issues #386 and #387 migrate PostgreSQL and SQLite to the facts.
Issue #388 must remove the transitional entry point and duplicated native analysis state after those migrations.
The new facts are private and are not exported from the package entry point.

Valibot still supplies runtime validation, metadata authoring and access, native public schema access, and type-level inference.
Operation-aware validation and metadata access are the next extraction, outside this change.
This boundary does not establish a public provider contract or complete provider independence.
