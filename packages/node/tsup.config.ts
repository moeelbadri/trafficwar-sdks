import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "node22",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
  noExternal: [/.*/],
  // Bundled CommonJS parser dependencies require Node built-ins in ESM too.
  banner: ({ format }) => format === "esm" ? {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  } : undefined,
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
    };
  },
});
