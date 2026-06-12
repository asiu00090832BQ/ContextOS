#!/usr/bin/env node
// Verify that the platform-specific native binaries the web build depends on
// (esbuild, rollup, lightningcss, @tailwindcss/oxide) actually materialized for
// the HOST platform after `pnpm install`.
//
// Why this exists: a past "Replit is linux-x64 only" optimization stripped every
// non-linux native optional dependency in pnpm config. That removed even the
// host's own binary on macOS/Windows, so `vite build` blew up (esbuild / rollup /
// lightningcss / tailwind-oxide) only on those platforms — and nothing caught it
// until a user hit it. This script fails loudly, on every platform, the moment a
// host-matching native package is missing.
//
// pnpm only ever materializes the current platform's binary by default (the
// optional deps are gated by npm `os`/`cpu`), so on a healthy install exactly one
// matching package per tool should be present in node_modules/.pnpm.

import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = join(repoRoot, "node_modules", ".pnpm");

const platform = process.platform; // 'linux' | 'darwin' | 'win32'
const arch = process.arch; // 'x64' | 'arm64'

// Each tool's native packages are published per-platform and live in
// node_modules/.pnpm as `<flattened-name>@<version>`. We match by a name prefix
// plus the host's os + arch tokens, which keeps us agnostic to libc/abi suffixes
// (gnu / musl / msvc) that differ per tool.
const tools = [
  { label: "esbuild", prefix: "@esbuild+" },
  { label: "rollup", prefix: "@rollup+rollup-" },
  { label: "lightningcss", prefix: "lightningcss-" },
  { label: "@tailwindcss/oxide", prefix: "@tailwindcss+oxide-" },
];

let entries;
try {
  entries = readdirSync(pnpmDir);
} catch (err) {
  console.error(`::error::Could not read ${pnpmDir}. Did 'pnpm install' run?`);
  console.error(String(err));
  process.exit(1);
}

function isNonEmptyDir(name) {
  try {
    const full = join(pnpmDir, name, "node_modules");
    return statSync(full).isDirectory();
  } catch {
    return true; // entry exists; treat presence as sufficient
  }
}

console.log(`Host platform: ${platform}-${arch}`);
console.log(`Scanning ${pnpmDir} for host-matching native binaries...\n`);

let failed = false;
for (const tool of tools) {
  const matches = entries.filter(
    (name) =>
      name.startsWith(tool.prefix) &&
      name.includes(platform) &&
      name.includes(arch) &&
      isNonEmptyDir(name),
  );
  if (matches.length === 0) {
    failed = true;
    const anyForTool = entries.filter((n) => n.startsWith(tool.prefix));
    console.error(
      `::error::Missing host-platform native binary for ${tool.label} ` +
        `(${platform}-${arch}). This is the cross-platform pnpm-config ` +
        `regression class — a fresh clone will fail to build here.`,
    );
    if (anyForTool.length > 0) {
      console.error(
        `  Found only other-platform builds: ${anyForTool.join(", ")}`,
      );
    } else {
      console.error(`  No ${tool.label} platform package found at all.`);
    }
  } else {
    console.log(`  OK  ${tool.label}: ${matches.join(", ")}`);
  }
}

if (failed) {
  console.error(
    "\nOne or more host-platform native binaries are missing. See errors above.",
  );
  process.exit(1);
}

console.log("\nAll host-platform native binaries present.");
