/**
 * Resolution hook so tests can import the real source modules.
 *
 * The source is written for a bundler: relative imports carry the `.js`
 * extension the compiled output will have. `node --experimental-strip-types`
 * runs the `.ts` files directly, so those specifiers point at files that do
 * not exist on disk and every test that touches a module with an internal
 * import dies with ERR_MODULE_NOT_FOUND. This rewrites `./x.js` to `./x.ts`
 * only when the `.js` is genuinely absent and the `.ts` is there, so a real
 * `.js` dependency still resolves exactly as before.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
    try {
      const asJs = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(asJs))) {
        const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
        if (existsSync(fileURLToPath(new URL(tsSpecifier, context.parentURL)))) {
          return next(tsSpecifier, context);
        }
      }
    } catch {
      // Anything unparseable falls through to Node's own resolver untouched.
    }
  }
  return next(specifier, context);
}
