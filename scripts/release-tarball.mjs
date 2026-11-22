#!/usr/bin/env node
// Builds the self-contained release tarball:
//
//   dist/paseo-mcp-<version>.tgz          top-level directory paseo-mcp/
//   dist/paseo-mcp-<version>.tgz.sha256   "<hex>  paseo-mcp-<version>.tgz" (sha256sum format)
//
// The tarball holds the plugin sources Paseo compiles itself (index.*.ts*, server/, shared/,
// client/), the built stdio server and admin CLI (dist/*.js) and the production node_modules. It
// installs with `paseo plugin install <dir>` and runs with `node <dir>/dist/index.js` without network
// access or npm. All dependencies are plain JavaScript, so one tarball serves every platform; the
// build fails if a native module shows up.
//
// RELEASE_VERSION=0.5.0-rc.1 builds a pre-release: the version in the file name, package.json and
// the version the server reports. SOURCE_DATE_EPOCH sets the file times (default: last commit).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, lutimesSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const NAME = "paseo-mcp";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = (process.env.RELEASE_VERSION ?? pkg.version).replace(/^v/, "");

function fail(message) {
  console.error(`release-tarball: ${message}`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}
function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    visit(path, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path, visit);
  }
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`not a version: ${version}`);
if (!version.startsWith(pkg.version)) fail(`RELEASE_VERSION ${version} does not belong to package version ${pkg.version}`);
const versionTs = readFileSync(join(root, "server", "version.ts"), "utf8");
if (!versionTs.includes(`VERSION = "${pkg.version}"`)) fail(`server/version.ts does not say ${pkg.version}`);

// 1. Build dist/ from this checkout.
run("npx", ["tsc"], { cwd: root });

// 2. Stage outside the repository, so nothing resolves from the repo's node_modules by accident.
const work = mkdtempSync(join(tmpdir(), "paseo-mcp-release-"));
const stage = join(work, NAME);
mkdirSync(stage);
const copy = [
  "package.json",
  "package-lock.json",
  "paseo-plugin.json",
  "index.server.ts",
  "index.client.tsx",
  "tsconfig.json",
  "tsconfig.plugin.json",
  "server",
  "shared",
  "client",
  "bin",
  "smoke.mjs",
  "config.example.json",
  "README.md",
  "CHANGELOG.md",
  "OVERVIEW.md",
  "LICENSE",
  "NOTICE",
];
for (const item of copy) cpSync(join(root, item), join(stage, item), { recursive: true });
mkdirSync(join(stage, "dist"));
for (const file of readdirSync(join(root, "dist"))) {
  if (file.endsWith(".js")) cpSync(join(root, "dist", file), join(stage, "dist", file));
}

// 3. Production dependencies, exactly as locked, without install scripts.
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: stage });

// 4. Platform independence: no native addons, no packages that need an install step.
const native = [];
walk(join(stage, "node_modules"), (path, entry) => {
  if (entry.isFile() && (path.endsWith(".node") || entry.name === "binding.gyp")) native.push(relative(stage, path));
  if (entry.isFile() && entry.name === "package.json") {
    const p = JSON.parse(readFileSync(path, "utf8"));
    if (p.gypfile || ["preinstall", "install", "postinstall"].some((s) => p.scripts?.[s])) native.push(relative(stage, path));
  }
  if (entry.isFile() && path.endsWith(".map")) rmSync(path);
});
if (native.length) fail(`platform-specific dependencies found:\n  ${native.join("\n  ")}`);

// 5. The version this build reports, and a package.json that does not try to build on install.
const stagedPkg = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
stagedPkg.version = version;
delete stagedPkg.scripts.prepare;
delete stagedPkg.scripts["release:tarball"];
writeFileSync(join(stage, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);
for (const file of [join(stage, "server", "version.ts"), join(stage, "dist", "version.js")]) {
  writeFileSync(file, readFileSync(file, "utf8").replace(`VERSION = "${pkg.version}"`, `VERSION = "${version}"`));
}

for (const file of ["index.js", "admin.js"]) chmodSync(join(stage, "dist", file), 0o755);

// 6. Checks against the staged tree.
await checkPluginBundles(stage);
await checkStdio(stage);
execFileSync(process.execPath, [join(stage, "dist", "admin.js"), "--help"], { stdio: "ignore" });

// 7. Pack with fixed times and owners.
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8" }).trim());
const when = new Date(epoch * 1000);
// node_modules/.bin holds only symlinks to CLIs nobody runs from here.
rmSync(join(stage, "node_modules", ".bin"), { recursive: true, force: true });
walk(stage, (path, entry) => (entry.isSymbolicLink() ? lutimesSync : utimesSync)(path, when, when));
utimesSync(stage, when, when);
const out = join(root, "dist");
mkdirSync(out, { recursive: true });
const tarball = `${NAME}-${version}.tgz`;
const tarPath = join(out, tarball);
rmSync(tarPath, { force: true });
const gnu = execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("GNU tar");
const ownerFlags = gnu
  ? ["--owner=0", "--group=0", "--numeric-owner", "--format=gnu"]
  : ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root", "--format", "ustar"];
// A sorted file list instead of recursion, so the order does not depend on the file system.
const entries = [NAME];
walk(stage, (path) => entries.push(relative(work, path).split(sep).join("/")));
entries.sort();
const listFile = join(work, "files.txt");
writeFileSync(listFile, `${entries.join("\n")}\n`);
console.log(`$ tar ${ownerFlags.join(" ")} --no-recursion -cf - -C ${work} -T files.txt | gzip -n > ${tarPath}`);
const tar = execFileSync("tar", [...ownerFlags, "--no-recursion", "-cf", "-", "-C", work, "-T", listFile], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
  maxBuffer: 1024 * 1024 * 1024,
});
// Node's gzip writes no name and no time into the header.
const gz = gzipSync(tar, { level: 9 });
writeFileSync(tarPath, gz);
const hash = createHash("sha256").update(gz).digest("hex");
writeFileSync(`${tarPath}.sha256`, `${hash}  ${tarball}\n`);
rmSync(work, { recursive: true, force: true });

const mb = (statSync(tarPath).size / 1024 / 1024).toFixed(1);
console.log(`\n${relative(process.cwd(), tarPath)} (${mb} MiB)\n${relative(process.cwd(), tarPath)}.sha256  ${hash}`);

// ---------------------------------------------------------------- checks

/** Bundles both plugin entries the way Paseo 0.17 does, resolving only inside the staged tree. */
async function checkPluginBundles(dir) {
  const { build } = await import("esbuild");
  const sdk = [
    "@getpaseo/plugin",
    "@getpaseo/plugin/server",
    "@getpaseo/plugin/server/provider",
    "@getpaseo/plugin/server/usage",
    "@getpaseo/plugin/server/acp",
    "@getpaseo/plugin/client",
    "@getpaseo/plugin/client/ui",
    "@getpaseo/plugin/client/react-native",
  ];
  const targets = [
    { entry: "index.server.ts", platform: "node", target: "node20", external: [...sdk, "zod"] },
    {
      entry: "index.client.tsx",
      platform: "neutral",
      target: "es2020",
      mainFields: ["module", "main"],
      external: [...sdk, "@tanstack/react-query", "react", "react/jsx-runtime", "react-native", "zod"],
    },
  ];
  for (const t of targets) {
    const result = await build({
      entryPoints: [join(dir, t.entry)],
      absWorkingDir: dir,
      bundle: true,
      format: "cjs",
      jsx: "automatic",
      platform: t.platform,
      target: t.target,
      mainFields: t.mainFields,
      external: t.external,
      metafile: true,
      logLevel: "silent",
      write: false,
    });
    const outside = Object.keys(result.metafile.inputs).filter((p) => {
      const abs = join(dir, p);
      return !abs.startsWith(dir + sep);
    });
    if (outside.length) fail(`${t.entry} resolves files outside the tarball: ${outside.join(", ")}`);
    console.log(`ok: ${t.entry} bundles from the staged tree (${Object.keys(result.metafile.inputs).length} inputs)`);
  }
}

/** Starts the staged stdio server with a minimal env and lists its tools over MCP. */
async function checkStdio(dir) {
  const cfgDir = mkdtempSync(join(tmpdir(), "paseo-mcp-cfg-"));
  const cfg = join(cfgDir, "config.json");
  // Port 9 (discard) has no daemon: tools/list must work without one.
  writeFileSync(cfg, JSON.stringify({ daemonUrl: "ws://127.0.0.1:9/ws", allowedRoots: [cfgDir] }));
  const child = spawn(process.execPath, [join(dir, "dist", "index.js")], {
    cwd: cfgDir,
    env: { PATH: process.env.PATH, HOME: cfgDir, PASEO_MCP_CONFIG: cfg, PASEO_HOME: cfgDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const replies = new Map();
  child.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) replies.get(msg.id)?.(msg);
    }
  });
  const call = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr}`)), 15_000);
      replies.set(id, (msg) => (clearTimeout(timer), resolve(msg)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const init = await call(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "release-check", version: "0" },
    });
    if (init.result?.serverInfo?.version !== version) fail(`stdio server reports ${JSON.stringify(init.result?.serverInfo)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = (await call(2, "tools/list")).result?.tools ?? [];
    if (tools.length < 11) fail(`stdio server lists ${tools.length} tools`);
    console.log(`ok: staged stdio server ${version} lists ${tools.length} tools`);
  } finally {
    child.kill();
    rmSync(cfgDir, { recursive: true, force: true });
  }
}
