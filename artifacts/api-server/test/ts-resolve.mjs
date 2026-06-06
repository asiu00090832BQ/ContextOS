import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The source uses `moduleResolution: bundler` (extensionless relative imports),
// which esbuild resolves at build time. When node:test runs the raw TS via
// native type-stripping, Node's ESM loader needs the explicit extension, so we
// append `.ts` (or `/index.ts`) for relative specifiers that lack one. This hook
// is chained beneath the test runner's module-mock loader, so mocked specifiers
// still resolve to the same URL keys and continue to intercept correctly.
export async function resolve(specifier, context, next) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExt = /\.[cm]?[jt]s$|\.json$/.test(specifier);
  if (isRelative && !hasExt && context.parentURL) {
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(url))) {
          return next(candidate, context);
        }
      } catch {
        // fall through to the default resolution below
      }
    }
  }
  return next(specifier, context);
}
