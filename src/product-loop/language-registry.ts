// src/product-loop/language-registry.ts
/**
 * THE single source of truth for "what does a source file / a test file / a
 * project manifest look like".
 *
 * Why this module exists: the repo scanners used to each carry their own
 * hand-maintained extension list, and they had already diverged —
 * `discovery-detection.ts` knew about `.cs` while `repo-audit.ts` did not, so
 * `auditRepo` reported "Source files: 1, test files: 0" for a 506-file C#
 * repository and the council/sprint planner was told the repo was empty.
 * Adding `.cs` to the second list would only have reset the clock until the
 * next language. Every consumer now derives from {@link SOURCE_LANGUAGES} and
 * {@link MANIFEST_SPECS}, so a language added here is visible to all of them
 * at once and a language cannot be visible to one scanner but not another.
 *
 * Invariant enforced at module load: no extension may be claimed by two
 * languages (an ambiguous extension would make the derived lookup depend on
 * declaration order, which is exactly the kind of silent drift this module
 * exists to prevent).
 */

export interface LanguageSpec {
  /** Display name surfaced to the model (`languages` in ExistingProjectSignals). */
  lang: string;
  /** Source-file extensions, lowercase, leading dot. Must be unique across all specs. */
  extensions: readonly string[];
  /**
   * Filename conventions that mark a file as a TEST rather than production
   * source, for this language. Matched against the basename.
   */
  testPatterns?: readonly RegExp[];
}

/**
 * Registry of source languages. Adding a language here makes it visible to
 * `auditRepo` (file counts + the context block the council reads) and to
 * `detectExistingProject` (greenfield-vs-existing classification) in one edit.
 */
export const SOURCE_LANGUAGES: readonly LanguageSpec[] = [
  {
    lang: "TypeScript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    testPatterns: [/\.(test|spec)\.[cm]?tsx?$/i],
  },
  {
    lang: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    testPatterns: [/\.(test|spec)\.[cm]?jsx?$/i],
  },
  {
    lang: "C#",
    extensions: [".cs"],
    // xUnit/NUnit/MSTest convention: FooTests.cs / FooTest.cs. Case-SENSITIVE
    // and boundary-anchored on purpose — a case-insensitive `tests?\.cs$`
    // silently swallows `Latest.cs`, `Greatest.cs`, `Protest.cs`, which would
    // move real production files into the test column. Same reasoning applies
    // to every PascalCase-suffix language below.
    testPatterns: [/(^|[a-z0-9_])Tests?\.cs$/],
  },
  {
    lang: "F#",
    extensions: [".fs", ".fsi", ".fsx"],
    testPatterns: [/(^|[a-z0-9_])Tests?\.fsx?$/],
  },
  {
    lang: "Visual Basic",
    extensions: [".vb"],
    testPatterns: [/(^|[a-z0-9_])Tests?\.vb$/],
  },
  {
    lang: "Python",
    extensions: [".py", ".pyi"],
    // pytest/unittest discover both `test_foo.py` and `foo_test.py`.
    testPatterns: [/^test_.*\.py$/i, /_test\.py$/i, /\.(test|spec)\.py$/i],
  },
  {
    lang: "Go",
    extensions: [".go"],
    testPatterns: [/_test\.go$/i],
  },
  {
    lang: "Rust",
    extensions: [".rs"],
    // Rust keeps unit tests inline; integration tests live in tests/, which
    // the directory rule already covers.
    testPatterns: [/^tests?\.rs$/i],
  },
  {
    lang: "Java",
    extensions: [".java"],
    testPatterns: [/(^|[a-z0-9_])Tests?\.java$/],
  },
  {
    lang: "Kotlin",
    extensions: [".kt", ".kts"],
    testPatterns: [/(^|[a-z0-9_])Tests?\.kts?$/],
  },
  {
    lang: "Scala",
    extensions: [".scala"],
    testPatterns: [/(^|[a-z0-9_])(Spec|Tests?)\.scala$/],
  },
  {
    lang: "Ruby",
    extensions: [".rb"],
    testPatterns: [/_(test|spec)\.rb$/i],
  },
  {
    lang: "PHP",
    extensions: [".php"],
    testPatterns: [/(^|[a-z0-9_])Tests?\.php$/],
  },
  {
    lang: "Swift",
    extensions: [".swift"],
    testPatterns: [/(^|[a-z0-9_])Tests?\.swift$/],
  },
  {
    lang: "C/C++",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh"],
    testPatterns: [/_(test|tests)\.(c|cc|cpp|cxx)$/i, /^test_.*\.(c|cc|cpp|cxx)$/i],
  },
  {
    lang: "Objective-C",
    extensions: [".m", ".mm"],
    testPatterns: [/(^|[a-z0-9_])Tests?\.mm?$/],
  },
  {
    lang: "Elixir",
    extensions: [".ex", ".exs"],
    testPatterns: [/_test\.exs?$/i],
  },
  {
    lang: "Dart",
    extensions: [".dart"],
    testPatterns: [/_test\.dart$/i],
  },
];

function buildExtensionIndex(): Map<string, LanguageSpec> {
  const index = new Map<string, LanguageSpec>();
  for (const spec of SOURCE_LANGUAGES) {
    for (const ext of spec.extensions) {
      const existing = index.get(ext);
      if (existing) {
        // Throw rather than silently letting declaration order decide: an
        // extension owned by two languages makes the derived lookups
        // order-dependent, which is the drift this registry prevents.
        throw new Error(
          `language-registry: extension "${ext}" is claimed by both "${existing.lang}" and "${spec.lang}". ` +
            "Each extension must belong to exactly one LanguageSpec.",
        );
      }
      index.set(ext, spec);
    }
  }
  return index;
}

const EXT_INDEX: ReadonlyMap<string, LanguageSpec> = buildExtensionIndex();

/**
 * Every recognised source extension. Derived — do not hand-maintain.
 *
 * @testonly Production code asks `isCodeFile()` instead of reading the set, so
 * that adding a language cannot leave one consumer holding a stale copy — that
 * divergence is the defect this registry exists to prevent. The set stays
 * exported because the behavioural pin test enumerates it to prove BOTH
 * consumers see every registered extension; a test that could not enumerate it
 * would have to hand-write the list, reintroducing the drift.
 */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set(EXT_INDEX.keys());

/**
 * Extension → display language. Derived — do not hand-maintain.
 *
 * @testonly Same reasoning as `CODE_EXTENSIONS`: production resolves a language
 * through `langForFile()`.
 */
export const SRC_EXT_TO_LANG: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Array.from(EXT_INDEX, ([ext, spec]) => [ext, spec.lang])),
);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return "";
  return filename.slice(dot).toLowerCase();
}

/** True when the filename carries a recognised source-code extension. */
export function isCodeFile(filename: string): boolean {
  return EXT_INDEX.has(extensionOf(filename));
}

/** Display language for a source file, or undefined when not source code. */
export function langForFile(filename: string): string | undefined {
  return EXT_INDEX.get(extensionOf(filename))?.lang;
}

/**
 * True when the filename follows a TEST naming convention for its own
 * language — `Foo.test.ts`, `FooTests.cs`, `foo_test.go`, `test_foo.py`,
 * `FooSpec.scala`, `foo_test.exs`, …
 *
 * Files that live under a test directory are tests regardless of name; that is
 * the caller's job via {@link isTestDirName}.
 */
export function isTestFile(filename: string): boolean {
  const spec = EXT_INDEX.get(extensionOf(filename));
  if (!spec?.testPatterns) return false;
  return spec.testPatterns.some((re) => re.test(filename));
}

/** Directory names that are unambiguously test roots, matched case-insensitively. */
const TEST_DIR_EXACT = new Set(["tests", "test", "__tests__", "spec", "specs", "testing"]);
/** `Foo.Tests`, `foo-test`, `integration_tests` — a suffix after a separator. */
const TEST_DIR_SUFFIX_RE = /[.\-_](tests?|specs?)$/i;

/**
 * True when a directory name marks a test root. Everything beneath such a
 * directory counts as a test file whatever it is named — .NET keeps
 * `src/tests/Foo.Tests/Bar.cs`, which no filename convention would catch.
 */
export function isTestDirName(dirName: string): boolean {
  const lower = dirName.toLowerCase();
  return TEST_DIR_EXACT.has(lower) || TEST_DIR_SUFFIX_RE.test(lower);
}

export interface ManifestSpec {
  /** Value written to ManifestDetection["type"]. */
  type: "package.json" | "Cargo.toml" | "go.mod" | "pyproject.toml" | "csproj" | "pom.xml" | "build.gradle";
  /** Stack this manifest proves. Manifests are deduped per language by the caller. */
  lang: string;
  /** Exact filenames (case-insensitive) that prove this manifest. */
  filenames?: readonly string[];
  /**
   * Extensions (lowercase, leading dot) that prove this manifest — for
   * ecosystems whose manifest is named after the project rather than fixed
   * (`Foo.sln`, `Foo.csproj`), which an exact-filename probe cannot see.
   */
  extensions?: readonly string[];
}

/**
 * Registry of project manifests. `matchManifest` resolves an entry name
 * against this list in order, so the first spec that claims a name wins.
 *
 * When one language is proven by several manifests at once (a .NET repo has a
 * .sln AND a .csproj AND Directory.Build.props), the caller collapses them to
 * one entry per language so the repo reads as a single stack rather than as a
 * polyglot — see `dedupeByLanguage` in discovery-detection.ts.
 */
export const MANIFEST_SPECS: readonly ManifestSpec[] = [
  { type: "package.json", lang: "TypeScript", filenames: ["package.json"] },
  { type: "Cargo.toml", lang: "Rust", filenames: ["Cargo.toml"] },
  { type: "go.mod", lang: "Go", filenames: ["go.mod"] },
  { type: "pyproject.toml", lang: "Python", filenames: ["pyproject.toml"] },
  { type: "pom.xml", lang: "Java", filenames: ["pom.xml"] },
  { type: "build.gradle", lang: "Java", filenames: ["build.gradle", "build.gradle.kts"] },
  // .NET proves itself several ways; all of them are the same C# stack, so
  // they share one spec and `dedupeByLanguage` collapses them to one entry.
  {
    type: "csproj",
    lang: "C#",
    filenames: ["Directory.Build.props", "Directory.Packages.props", "global.json"],
    extensions: [".sln", ".slnx", ".csproj"],
  },
  { type: "csproj", lang: "F#", extensions: [".fsproj"] },
  { type: "csproj", lang: "Visual Basic", extensions: [".vbproj"] },
];

/**
 * Match one directory entry name against the manifest registry. Returns the
 * first matching spec (registry order = priority) or null.
 *
 * Note this deliberately does NOT care whether the entry is a file or a
 * directory — a directory named `package.json` is still reported, and the
 * caller's read failure downgrades it to weight 0, preserving long-standing
 * behaviour.
 */
export function matchManifest(entryName: string): ManifestSpec | null {
  const lower = entryName.toLowerCase();
  const ext = extensionOf(entryName);
  for (const spec of MANIFEST_SPECS) {
    if (spec.filenames?.some((f) => f.toLowerCase() === lower)) return spec;
    if (ext && spec.extensions?.includes(ext)) return spec;
  }
  return null;
}
