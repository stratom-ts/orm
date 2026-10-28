# Inference acceptance matrix

This inventory records the existing contract before the #375 test changes. Its
expectations come from #39's required behavior, the README inference reference,
and the PostgreSQL/SQLite support tables in `docs/dialects.md` at baseline
`9942754`. They do not come from the analysis or normalization helpers under test.

`A` means accepted with built-in mapping. `R` means rejected. `H` means an explicit
selected physical type and both effective mapping hooks must own the contract.
`I`, `M`, `Q`, `C`, and `T` mean inference, mapping/client validation, native CRUD,
catalog/convergence, and inferred read/write types. A native CRUD check includes
insert returning, a value predicate, select, and update returning. Where several
schemas use one mapping behavior, the equivalence rule below bounds native checks.

## Inferred output families

| ID  | Authored schema or constraint                          | Result                 | PostgreSQL storage                  | SQLite storage                      | JavaScript output                                  | Boundaries |
| --- | ------------------------------------------------------ | ---------------------- | ----------------------------------- | ----------------------------------- | -------------------------------------------------- | ---------- |
| S01 | string                                                 | A                      | text                                | TEXT                                | string                                             | I M Q C T  |
| S02 | string maxLength 255 / 256                             | A                      | varchar(255) / text                 | TEXT                                | string                                             | I M Q C T  |
| S03 | uuid                                                   | A                      | uuid                                | TEXT                                | string, PostgreSQL lowercase                       | I M Q C T  |
| S04 | ip / ipv4 / ipv6                                       | A                      | inet                                | TEXT                                | string, PostgreSQL canonical address               | I M Q C T  |
| S05 | mac48                                                  | A                      | macaddr                             | TEXT                                | string, PostgreSQL canonical MAC                   | I M Q C T  |
| S06 | mac / mac64                                            | A                      | macaddr8                            | TEXT                                | string, six-byte MAC may expand                    | I M Q C T  |
| S07 | decimal string                                         | A                      | numeric                             | TEXT                                | exact decimal string, native spelling may change   | I M Q C T  |
| N01 | number / fractional choices                            | A                      | double precision                    | REAL                                | number                                             | I M Q C T  |
| N02 | integer without bounds                                 | A                      | integer                             | INTEGER                             | number                                             | I M Q C T  |
| N03 | integer with both int16 bounds                         | A                      | smallint                            | INTEGER                             | number                                             | I M Q C T  |
| N04 | safeInteger / bounds beyond int32                      | A                      | bigint                              | INTEGER                             | safe number                                        | I M Q C T  |
| N05 | bigint without two int64 bounds                        | A                      | numeric                             | BIGINT                              | bigint; SQLite int64 only                          | I M Q C T  |
| N06 | bigint with two int64 bounds / choices                 | A                      | bigint                              | BIGINT                              | bigint                                             | I M Q C T  |
| B01 | boolean / boolean choices                              | A                      | boolean                             | BOOLEAN                             | boolean                                            | I M Q C T  |
| D01 | Date / toDate output                                   | A                      | timestamptz                         | DATETIME                            | Date                                               | I M Q C T  |
| D02 | isoDate                                                | A                      | date                                | TEXT                                | YYYY-MM-DD string                                  | I M Q C T  |
| D03 | isoTime                                                | A                      | time                                | TEXT                                | minute-time string                                 | I M Q C T  |
| D04 | isoTimeSecond                                          | A                      | time                                | TEXT                                | second-time string                                 | I M Q C T  |
| D05 | isoDateTime                                            | A                      | timestamp                           | TEXT                                | local minute datetime string                       | I M Q C T  |
| D06 | isoDateTimeSecond                                      | A                      | timestamp                           | TEXT                                | local second datetime string                       | I M Q C T  |
| D07 | isoTimestamp                                           | A                      | timestamptz                         | TEXT                                | offset/Z string, native precision up to six digits | I M Q C T  |
| J01 | object / array / tuple / record JSON-compatible output | A                      | jsonb                               | JSON                                | structured value                                   | I M Q C T  |
| P01 | toNumber then validators                               | A                      | output number width                 | INTEGER / REAL                      | number, input remains independently typed          | I M Q C T  |
| P02 | toBoolean / parseBoolean                               | A                      | boolean                             | BOOLEAN                             | boolean                                            | I M Q C T  |
| P03 | toString                                               | A                      | text                                | TEXT                                | string                                             | I M Q C T  |
| P04 | parseJson then supported structured schema             | A                      | jsonb                               | JSON                                | final structured output                            | I M Q C T  |
| P05 | arbitrary transform / bare parseJson                   | R inference; H mapping | explicit                            | explicit                            | hook-owned output                                  | I M Q T    |
| P06 | unknown transform then supported schema                | A                      | recovered output storage            | recovered output storage            | final schema output                                | I M Q C T  |
| P07 | validation-only later same-kind schema                 | A                      | retain bounds/formats/finite proofs | retain bounds/formats/finite proofs | original output kind                               | I M Q C T  |

## Finite output/storage compatibility

Each accepted cell must check validation, a concrete parameter, a separately written
driver value, and its expected result. SQL NULL is checked separately from a
non-null value. Aliases are finite spellings below, not arbitrary SQL syntax.

| ID  | Output                                                | Accepted PostgreSQL storage classes                                                                               | Rejected PostgreSQL controls                                                                 |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| PM1 | string                                                | text, varchar(n), char(n), uuid, inet, macaddr, macaddr8, numeric/decimal, money, date/time/timestamp/timestamptz | boolean, integer widths, real/double, oid, json/jsonb, bytea, interval, point/circle, arrays |
| PM2 | number                                                | smallint/int2, integer/int4, bigint/int8, smallserial/serial/bigserial, real/float4, double precision/float8      | text/varchar, numeric/decimal                                                                |
| PM3 | bigint                                                | smallint/int2, integer/int4, bigint/int8, all three serial spellings, numeric/decimal (including precision/scale) | real/double, text                                                                            |
| PM4 | boolean                                               | boolean/bool                                                                                                      | text, integer                                                                                |
| PM5 | Date                                                  | date, timestamp without time zone, timestamp with time zone and precision forms                                   | text, time, numeric                                                                          |
| PM6 | JSON-compatible structured                            | json/jsonb                                                                                                        | text, integer                                                                                |
| PM7 | unknown()/any()                                       | PostgreSQL pass-through storage                                                                                   | SQLite requires H                                                                            |
| PM8 | unresolved transform / mixed choice or representation | H only                                                                                                            | a physical override alone cannot prove an output                                             |
| PM9 | proven ISO string                                     | its native temporal base type, optional precision; text/varchar                                                   | a different temporal base type requires H                                                    |

PostgreSQL PM1 partitions the documented string complement into text, native
format/numeric, and temporal mapper behaviors. It does not promise every engine
type can accept every string value. Network/MAC canonicalization belongs to the
native engine. Integer-width overflow belongs to PostgreSQL; unsafe number to
bigint conversion must fail explicitly before rounding. `real` has PostgreSQL's
single-precision storage and is tested with exactly representable values.

| ID  | Output                              | TEXT | INTEGER | REAL | NUMERIC | BLOB | Parameter / result contract            |
| --- | ----------------------------------- | ---- | ------- | ---- | ------- | ---- | -------------------------------------- |
| SM1 | string                              | A    | R       | R    | R       | A    | exact text / string                    |
| SM2 | number                              | R    | A       | A    | A       | A    | finite safe number / number            |
| SM3 | boolean                             | R    | A       | A    | A       | A    | 0 or 1 / boolean                       |
| SM4 | bigint                              | R    | A       | R    | A       | A    | signed-int64 bigint / bigint           |
| SM5 | Date                                | A    | A       | A    | A       | A    | ISO text / Date                        |
| SM6 | JSON-compatible structured          | A    | A       | A    | A       | A    | bracketed JSON text / structured value |
| SM7 | unknown/any/unresolved/mixed output | H    | H       | H    | H       | H    | both hooks required                    |

SQLite aliases partition by documented affinity: VARCHAR/CHARACTER VARYING (TEXT),
BIGINT/INT and FLOATING POINT (INTEGER precedence), DOUBLE (REAL), DECIMAL/DATETIME
(NUMERIC), and an untyped/BLOB declaration (BLOB). One canonical type and finite
alias controls exercise normalization separately from each logical mapping cell.

## Range and precision boundaries

| ID  | Case                                                                   | Expected behavior                                        | Boundaries |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------- | ---------- |
| E01 | number output, bigint/int8/bigserial, ±9007199254740991                | exact number in both directions                          | M Q T      |
| E02 | adjacent unsafe integer or unsafe numeric driver number                | QueryError, no silent rounding                           | M Q        |
| E03 | SQLite bigint endpoints -9223372036854775808 / 9223372036854775807     | exact bigint; adjacent values reject                     | I M Q      |
| E04 | PostgreSQL numeric bigint beyond int64, integer-valued scaled decimals | exact bigint; fractions and unsafe driver numbers reject | M Q T      |
| E05 | PostgreSQL numeric string with precision beyond JS number              | remains a string                                         | M Q T      |
| E06 | strict minute/second temporal output with finer nonzero stored digits  | QueryError; no truncation                                | M Q        |
| E07 | PostgreSQL ISO timestamp microseconds / Date milliseconds              | keep documented precision and output kind                | M Q T      |
| E08 | SQLite Infinity/NaN or unsafe integral number, including REAL/NUMERIC  | QueryError                                               | I M Q      |

## Interactions and equivalence classes

| ID  | Finite cases                                                                           | Expected behavior                                                                  | Evidence owner / initial gap                                                           |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| W01 | optional, exactOptional, nullable, nullish, undefinedable                              | independent omission / undefined / SQL NULL semantics                              | analyzeSchema, views, query/validate; existing                                         |
| W02 | nonOptional, nonNullable, nonNullish outer reversals                                   | inside-out permission removal; retain nested constraints                           | analyzeSchema, views, defineTable; existing                                            |
| W03 | application default, SQL default, generated value, DEFAULT NULL                        | NOT NULL omission needs non-null source; SQL NULL remains independently observable | defineTable, shared nullable-default integration; existing                             |
| W04 | nullable input transformed non-null; non-null input transformed nullable               | read and write views differ exactly; no rerun on read                              | shared transformed-null / nullable-output scenarios; existing                          |
| C01 | string/integer/fractional/bigint/boolean literal, enum, picklist                       | value-based type and exact primitive output                                        | member Schema and choiceInference suites; extend missing native operations             |
| C02 | compatible union, variant, intersection, null union                                    | widen compatible storage, preserve output/SQL nullability                          | member Schema + shared composites; existing                                            |
| C03 | outer number/bigint bounds; later same-kind composite/choice schema                    | retain and intersect validation proofs                                             | #346/#350/#352/#358 regressions; existing                                              |
| C04 | number/bigint, Date/string, mixed native temporal representations                      | reject or H; equal affinity alone is insufficient                                  | member Schema/Mapping, clientValueMapping; existing                                    |
| C05 | nested Date/bigint/undefined or nonfinite JSON; recovered nested conversion/projection | reject unsafe output or H; accept proven final JSON output                         | #360/#365 analysis/member/shared scenarios; existing                                   |
| R01 | direct, nullable, chained reference to inferred/overridden target                      | inherit selected physical type and output context                                  | DesiredSchema, clientValueMapping, native formats/serial/composites; existing          |
| R02 | authored minute/second temporal reference, conflicting output kind                     | authored format wins; reject incompatible representation before SQL                | postgres.temporal + member/client mapping; existing                                    |
| R03 | same-table, cross-table, inner/outer join projection of nullable composite             | retain SQL nullability; preserve transformed non-null controls                     | #359/#364 views and shared nullable-default join; existing                             |
| O01 | selected-member override vs unrelated-member override                                  | selected override wins; unrelated override does not suppress inference             | member DesiredSchema/client tests; existing                                            |
| O02 | zero, one, paired column/client hooks and mixed pairs                                  | unsupported mapping needs both effective directions; column wins per direction     | clientValueMapping, sqlitePhysicalValueTypes; extend finite hook directions if missing |
| F01 | repeated format and shared-target formats; conflicting native formats both orders      | compatible repeats accept; conflicting targets reject independently of order       | member Schema/DesiredSchema, analyzeSchema; existing                                   |
| A01 | inference/client SchemaError, lowering MigrationError with SchemaError cause           | portable defineTable does not choose a dialect                                     | member Schema/DesiredSchema/client tests; existing                                     |
| A02 | query/result mapping and migration preview unexpected defects                          | preserve thrown value and stack by identity under ADR 0003                         | clientValueMapping and migration suites; existing                                      |

Wrappers operate on omission and nullability facts independently of scalar storage.
Every wrapper/reversal is therefore checked at analysis, view, and validation
boundaries. Native transformed-null/default cases prove SQL execution for the
distinct stored-null and consumed-null behaviors. This avoids multiplying every
wrapper by every native format and SQL alias.

Choices and compatible composites share their proven scalar/JSON mapper with
plain output. Inference tests enumerate branch widths, bounds, native conflicts,
and identity rejection. Native tests cover distinct widened number/bigint/Date,
JSON variant/intersection, nullable/default, and reference behavior. Hook tests
enumerate effective direction ownership rather than every hook function body.

## Coverage work identified before adding tests

1. Replace PostgreSQL compatible-storage acceptance-only examples with independent
   parameter/result assertions across PM1-PM7 and finite aliases.
2. Add the complete SQLite six-output by five-affinity validation/value matrix,
   with separate alias and rejection controls.
3. Audit native suites by operation and value family. Fill missing predicate,
   update-returning, JSON collection, and catalog/convergence assertions through
   existing shared scenarios and member suites.
4. Keep the named defect regressions intact. The completion report must give exact
   test titles and observed checks, not infer coverage from closed issue status.

This matrix is the bounded contract. It excludes arbitrary SQL type spellings,
arbitrary Valibot schema combinations, new codecs, read validation, and #368 naming
cleanup. A discovered failure within a listed cell blocks completion until fixed
or explicitly reported.
