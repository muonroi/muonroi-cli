import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: false,
    include: ["__tests__/**/*.spec.{ts,tsx}"],
  },
  esbuild: {
    jsx: "transform",
    jsxInject: `import React from 'react'`,
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  },
  define: {
    __MUONROI_HARNESS__: "true",
  },
});
