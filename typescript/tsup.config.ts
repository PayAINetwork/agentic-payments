import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "middleware/express": "src/middleware/express.ts",
    "middleware/hono": "src/middleware/hono.ts",
    "middleware/next": "src/middleware/next.ts",
    "middleware/elysia": "src/middleware/elysia.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: true,
  treeshake: true,
});
