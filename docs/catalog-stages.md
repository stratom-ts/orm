# Catalog observation stages

Catalog observation turns a scoped `CatalogRequest` into a `CatalogSnapshot` for
migration planning and execution. Each dialect owns this work inside its private
`catalog.ts` module. The stages below describe the current PostgreSQL and SQLite
implementations; they are not a shared generic decoder.

Snapshots preserve the distinction between evidence and missing knowledge. A
`CatalogFact` says `present`, `absent`, or carries a no-evidence state. A set reports
`complete`, `partial`, or a no-evidence state through `CatalogCoverage`. A
`CatalogCapability` reports supported fidelity, unsupported behavior with a reason, or
unavailability. Missing query rows alone never prove absence. See the
[catalog types](../src/dialects/catalog.ts) and the [dialect catalog contract](dialects.md#catalog-observation).

## PostgreSQL

The entry point is private `introspectPostgresCatalog()` in
[`postgres/catalog.ts`](../src/dialects/postgres/catalog.ts#L1519). It performs these
stages in order:

1. **Acquire context and resolve the request.** [`readCatalogContext()`](../src/dialects/postgres/catalog.ts#L1178) reads server
   version, `current_database()`, and `current_schema()`, then creates canonical
   identities and resolves requested relations and namespaces. [`resolveCatalogScope()`](../src/dialects/postgres/catalog.ts#L1573)
   derives the schema query scope and relation membership predicate. Servers below the
   supported version use [`versionLimitedCatalog()`](../src/dialects/postgres/catalog.ts#L1476) to return explicit unavailable
   evidence.
2. **Acquire native evidence.** [`createCatalogQueries()`](../src/dialects/postgres/catalog.ts#L1133) builds scoped queries for
   namespaces, relations, columns, constraints, indexes, opaque objects, and name
   reservations. [`readRawCatalogEvidence()`](../src/dialects/postgres/catalog.ts#L1807) executes them in order. These queries use
   PostgreSQL catalogs such as `pg_class`, `pg_attribute`, `pg_constraint`, and
   `pg_index`; native constraint and index definitions are retained where useful.
3. **Validate consistency.** [`readCatalogEvidence()`](../src/dialects/postgres/catalog.ts#L1225) repeats the scoped namespace,
   relation-member, and reservation observations and checks them against the first read.
   It also rechecks requested relation identities and object IDs. A changed observation
   throws retryable `MigrationError` at stage `introspection` with outcome `unchanged`.
4. **Decode and assemble.**
   [`assemblePostgresCatalog()`](../src/dialects/postgres/catalog.ts#L2156) uses strict
   row decoders such as [`rowAt()`](../src/dialects/postgres/catalog.ts#L280),
   [`stringAt()`](../src/dialects/postgres/catalog.ts#L298),
   [`booleanAt()`](../src/dialects/postgres/catalog.ts#L354),
   [`stringArrayAt()`](../src/dialects/postgres/catalog.ts#L464), and
   [`formatPostgresCatalogDataType()`](../src/dialects/postgres/catalog.ts#L643). It
   attaches columns, keys, foreign keys, indexes, opaque objects, and name reservations
   to canonical relations. Constraint and index
   decoding checks semantic validity and records native definitions; unsupported native
   semantics remain represented as evidence rather than being simplified into portable
   claims. Namespace and relation ordering is deterministic.
5. **Build the snapshot.** [`createPostgresSnapshot()`](../src/dialects/postgres/catalog.ts#L2212) adds the source version, resolved
   request, writable namespace context, supported capability evidence, complete
   collection coverage, and ordered diagnostics.

Malformed returned PostgreSQL context or catalog rows are `InvariantError` defects.
Executor failures keep their original error path. In particular, a failed query is not
recast as unavailable catalog capability evidence.

### Invalid index recovery evidence

Index validity and semantic fidelity remain separate facts. Planning records explicitly
invalid supported indexes separately from unknown validity. An unambiguous desired
match produces creation intent without satisfying desired state, independent of physical
policy or grants. The original snapshot remains private lowering evidence for a possible
repair. Opaque, conflicting, unrelated or ambiguous indexes stay guarded. PostgreSQL
lowering checks ordinary table kind, persistence, standalone origin and supported index
semantics before permitting concurrent operations. See
[ADR 0004](adr/0004-concurrent-index-execution.md).

## SQLite

The entry point is private `introspectSqliteCatalog()` in
[`sqlite/catalog.ts`](../src/dialects/sqlite/catalog.ts#L1366). It tracks executor
rejections before applying metadata recovery, so a thrown value from the executor is
re-thrown unchanged even when it is an `InvariantError` or
`SqliteTableMetadataError` instance.

1. **Acquire context and resolve the request.** [`readCatalogContext()`](../src/dialects/sqlite/catalog.ts#L822) decodes SQLite
   version evidence, establishes the `main` writable namespace, and resolves canonical
   relation identities. Requests for attached database relations or namespaces currently
   raise `InvariantError`. Version metadata that
   cannot be trusted, and versions below the supported range, produce snapshots with
   unknown or unavailable evidence.
2. **Acquire inventory.** [`readSqliteInventory()`](../src/dialects/sqlite/catalog.ts#L1731) reads `database_list` and
   `table_list`, then reads schema definitions from `sqlite_schema`. It validates
   database aliases and relation uniqueness, and records views, triggers, and possible
   external dependencies. [`readTableInventory()`](../src/dialects/sqlite/catalog.ts#L1523) keeps both the native table inventory
   and schema rows for later proof.
3. **Acquire scoped table evidence.** [`prepareSqliteCatalogEvidence()`](../src/dialects/sqlite/catalog.ts#L1778) selects requested
   tables, validates relevant schema rows, and calls [`readTableEvidence()`](../src/dialects/sqlite/catalog.ts#L987) for native
   `table_xinfo`, `index_list`, `index_xinfo`, and `foreign_key_list` observations.
   `proveSqliteTables()` in [`sqlite/tableProof.ts`](../src/dialects/sqlite/tableProof.ts#L2957)
   checks those observations against parsed table and index definitions from
   `sqlite_schema`. This cross-check supports claims about columns, keys, constraints,
   indexes, and opaque native objects. It complements PostgreSQL's native catalog
   evidence; both paths preserve facts that cannot be reduced to portable semantics.
4. **Validate consistency and reservations.** Before collecting global name
   reservations, [`collectConsistentNameReservations()`](../src/dialects/sqlite/catalog.ts#L1444) calls [`assertCatalogUnchanged()`](../src/dialects/sqlite/catalog.ts#L1118).
   The consistency checks repeat scoped database, table, schema, column, index, and
   foreign-key observations. Owned metadata errors can become unknown snapshot evidence;
   executor rejections remain unchanged.
5. **Assemble the snapshot.** [`buildSqliteSnapshot()`](../src/dialects/sqlite/catalog.ts#L1471) and
   [`buildMainCatalogNamespace()`](../src/dialects/sqlite/catalog.ts#L1547) combine proven relations, diagnostics, reservations,
   capabilities, and coverage. A per-table proof error is retained on that relation and
   makes relation coverage partial. External namespace dependencies can restrict
   management and opaque-object coverage without claiming those objects are absent.

`SqliteTableMetadataError` is an internal tagged error for recognized table-proof
failures. Malformed inventory or context that the owned boundary can safely classify
produces `unknown` coverage with a diagnostic. Errors during proof of an individual
table produce partial coverage. Unexpected thrown values are defects and are never
converted into catalog capability evidence. This follows
[ADR 0003](adr/0003-expected-errors-and-defects.md): boundaries recognize only errors
they own and preserve other failures.

## Change-driven boundaries

Keep the public seam as the complete dialect facet, `CatalogIntrospector` returning a
complete `CatalogSnapshot`. The exported `postgresCatalog` and `sqliteCatalog` facet
values keep their implementations private. A future extraction is useful if PostgreSQL
native query acquisition starts changing independently from strict row decoding and
snapshot assembly; that is a cohesive seam with an independent change pattern. SQLite's
table proof already has its own module for the same reason. Keep new helpers private
unless a real consumer needs a stable interface. Do not add mirrored empty modules or a
generic decoder for these different evidence paths.

Any split must retain malformed-metadata behavior, tagged facts/coverage/capabilities,
diagnostics, and expected-error boundaries. It must also preserve canonical relation
identity ([ADR 0001](adr/0001-canonical-relation-identity.md)), structured Migration
Targets ([ADR 0002](adr/0002-structured-migration-plan-targets.md)), stable Migration
Plans and Semantic Profiles, and the defect rules in ADR 0003.
