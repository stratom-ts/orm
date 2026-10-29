# Internal storage facts

`src/storage/facts.ts` describes logical storage evidence without validation-library types or native schema references.
The internal `src/schemas/valibot` module traverses native schemas and produces these facts directly.
Extraction does not validate values or execute defaults, fallbacks, transformations, or mapping hooks.
Singleton assertions and finite choices remain distinct even when they describe the same value.
Defaults distinguish absence, a known value (including null), and an unevaluated factory.
Input acceptance, possible undefined output, SQL nullability, and insert omission remain separate facts.

Shared desired-schema registration extracts facts before calling a dialect.
Authored columns carry `facts` instead of `schema`, and authored tables do not expose their native table handles.
The shared lowering boundary restores table-handle associations after dialect storage decisions finish.
PostgreSQL and SQLite use facts for physical inference, desired-schema lowering, value mapping, and database-default compatibility.
Query mapping supplies resolved target `facts` and local `authoredFacts` for reference columns.
Physical overrides do not replace this logical evidence.

The pre-release dialect extension signatures intentionally change:

- `DialectSchema.inferColumnType(facts)` accepts storage facts instead of a native schema.
- `DialectSchema.lowerDesiredSchema()` accepts a fact-based authored graph and returns `StorageDesiredSchema`, without native table handles.
- `DialectValueMappingContext` carries `facts` and optional `authoredFacts`, replacing `schema` and `authoredSchema`.
- The legacy `analyzeSchema`, `SchemaAnalysis`, and analysis constraint-helper exports are removed.

These changes have no compatibility facades or deprecated aliases.
Storage facts support the dialect extension signatures without introducing a public schema-provider registration contract.
Native-purpose helpers remain where schema authoring or validation still needs them.

`singletonValue` retains the original literal when later constraints narrow its finite set.
`inputSingleton` preserves the explicit-type safety check for authored literals.
`jsonShape` describes effective JSON output.
`defaultJsonShape` retains the existing database-default compatibility rule based on the input's array or tuple shape.
These distinctions preserve existing storage policy rather than introduce new inference rules.

Valibot still supplies runtime validation, metadata authoring and access, native public schema access, and type-level inference.
Operation-aware validation and metadata access are the next extraction, outside this change.
This completes only the first storage-analysis milestone of #384.
It does not establish complete provider independence or add another provider.
