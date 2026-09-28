import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Compile the C++ helpers from source instead of trusting the committed
 * binaries in bin/. Those were built once in a specific Nix environment and
 * are dynamically linked against an exact glibc store path
 * (/nix/store/<hash>-glibc-<version>); if this deploy's Nix store doesn't
 * have that exact derivation, the binary can't execute at all ("cannot
 * execute: required file not found"), silently breaking the Strategy page's
 * concept scan. Compiling fresh removes that fragility. If no C++ compiler
 * is available, fall back to whatever is already committed rather than
 * failing the whole build over an optional step.
 */
function compileNative() {
  const compiler = ["g++", "clang++"].find(
    (cc) => spawnSync(cc, ["--version"], { stdio: "ignore" }).status === 0,
  );
  const binDir = path.resolve(artifactDir, "bin");
  const targets = [
    { src: path.resolve(artifactDir, "../expert-system/expert_system.cpp"), out: path.join(binDir, "expert-system") },
    { src: path.resolve(artifactDir, "../chunker/chunker.cpp"), out: path.join(binDir, "chunker") },
  ];
  if (!compiler) {
    console.warn("No C++ compiler (g++/clang++) found; keeping committed bin/ binaries as-is. " +
      "If the Strategy page's scan fails with a spawn error, this environment needs a C++ toolchain.");
    return;
  }
  for (const { src, out } of targets) {
    const res = spawnSync(compiler, ["-O2", "-std=c++17", "-o", out, src], { stdio: "inherit" });
    if (res.status !== 0) {
      throw new Error(`Failed to compile ${src} with ${compiler} (exit ${res.status})`);
    }
    console.log(`Compiled ${path.basename(src)} -> ${out}`);
  }
}

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await mkdir(path.resolve(artifactDir, "bin"), { recursive: true });
  compileNative();

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
      "pdf-parse",
      "pdfjs-dist",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
