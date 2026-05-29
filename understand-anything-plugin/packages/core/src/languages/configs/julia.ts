import type { LanguageConfig } from "../types.js";

export const juliaConfig = {
  id: "julia",
  displayName: "Julia",
  extensions: [".jl"],
  treeSitter: {
    wasmPackage: "tree-sitter-julia",
    wasmFile: "tree-sitter-julia.wasm",
  },
  concepts: [
    "multiple dispatch",
    "modules",
    "parametric types",
    "macros",
    "broadcasting",
    "comprehensions",
    "do blocks",
    "keyword arguments",
    "type annotations",
    "metaprogramming",
  ],
  filePatterns: {
    entryPoints: [
      "main.jl",
      "run.jl",
    ],
    barrels: [
      "Project.jl",
    ],
    tests: [
      "runtests.jl",
      "test_*.jl",
      "*_test.jl",
    ],
    config: [
      "Project.toml",
      "Manifest.toml",
    ],
  },
} satisfies LanguageConfig;
