export * from "./generated/api";
export * from "./generated/types";
// TypeScript resolves an `export *` ambiguity in favor of an explicit named
// re-export — this is what actually wins, not the file's position or the
// order of the two lines above. Orval regenerates both ./generated/api and
// ./generated/types on every codegen run, and (as of orval 8.38.0) also
// re-appends the `export * from "./generated/types"` line above into this
// hand-written file if it's ever removed — so excluding one side file-by-file
// doesn't survive a codegen run. Naming the value here instead does, because
// it doesn't depend on this file's shape at all, only on TypeScript's own
// disambiguation rule. Add a line here for any future operationId whose
// generated request-body type collides with a same-named component schema.
export { BulkDeleteTradesBody } from "./generated/api";
