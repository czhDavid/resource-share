import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: true,
    dts: true,
    sourcemap: true,
    splitting: false,
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    dts: false,
    sourcemap: true,
    splitting: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
