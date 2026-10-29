# Internal storage facts

`src/storage/facts.ts` describes logical storage evidence without validation-library types or native schema references.
`src/schemas/valibot` owns the native analysis traversal and projects its result into these facts.
Projection does not validate values or execute defaults, fallbacks, transformations, or mapping hooks.
Singleton assertions and finite choices remain distinct even when they describe the same one value.
Defaults distinguish absence, a known value (including null), and an unevaluated factory.

The extraction is additive. Existing consumers still use the native analysis representation through `src/schemas/utils/analyzeSchema.ts`.
PostgreSQL and SQLite storage decisions use these facts after #386 and #387. Their native-schema entry adapters are temporary until #388 supplies facts through shared contexts.
Issue #388 must remove the transitional entry point and duplicated native analysis state after those migrations.
The new facts are private and are not exported from the package entry point.

Valibot still supplies runtime validation, metadata authoring and access, native public schema access, and type-level inference.
Operation-aware validation and metadata access are the next extraction, outside this change.
This boundary does not establish a public provider contract or complete provider independence.

SQLite inference, desired-schema lowering, value mapping, and default compatibility now
make storage decisions from these facts. `singletonValue` retains the original literal
when later constraints narrow its finite set, and `inputSingleton` preserves the
explicit-type safety check for authored literals. `jsonShape` describes effective JSON
output; `defaultJsonShape` retains the existing database-default compatibility rule
based on the base schema's array or tuple shape. Temporary native-schema entry points
extract facts for existing callers; #388 replaces them when shared interfaces carry
facts directly.
