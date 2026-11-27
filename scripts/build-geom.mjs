// Builds the geometry core (crates/kerf-geom, through crates/kerf-wasm) to WebAssembly and puts it where the app
// loads it from: src/geom/kerf_geom.wasm, with src/geom/kerf_geom.json beside it recording which Rust sources it was
// built from. Both are committed, so the app and its tests run without a Rust toolchain; tests/geomCore.test.ts
// fails when the Rust has changed since.
//
//   npm run geom            build and copy
//   npm run geom -- --check only say whether the committed build is up to date (exit 1 when it is not)
//
// Needs Rust with the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src/geom/kerf_geom.wasm");
const stamp = join(root, "src/geom/kerf_geom.json");

/** A hash of everything the build reads: the crates' sources and manifests, and the lock file. */
export function sourcesHash() {
  const files = [join(root, "Cargo.toml"), join(root, "Cargo.lock")];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "target") walk(p);
      } else if (name.endsWith(".rs") || name === "Cargo.toml") files.push(p);
    }
  };
  walk(join(root, "crates"));
  const h = createHash("sha256");
  for (const f of files.sort()) {
    h.update(relative(root, f).split("\\").join("/"));
    h.update("\0");
    // line endings as git stores them, so a Windows checkout hashes the same
    h.update(readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
    h.update("\0");
  }
  return h.digest("hex");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sources = sourcesHash();
  if (process.argv.includes("--check")) {
    let built = "";
    try {
      built = JSON.parse(readFileSync(stamp, "utf8")).sources;
    } catch {
      /* no stamp: not built */
    }
    if (built !== sources) {
      console.error("src/geom/kerf_geom.wasm was built from other Rust sources than the ones here: run `npm run geom`.");
      process.exit(1);
    }
    console.log("src/geom/kerf_geom.wasm is up to date.");
  } else {
    execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "kerf-wasm"], { cwd: root, stdio: "inherit" });
    copyFileSync(join(root, "target/wasm32-unknown-unknown/release/kerf_wasm.wasm"), out);
    writeFileSync(stamp, JSON.stringify({ sources }, null, 2) + "\n");
    console.log(`src/geom/kerf_geom.wasm: ${statSync(out).size} bytes`);
  }
}
