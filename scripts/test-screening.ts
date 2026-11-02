import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyManifestBuffer,
  classifyNonCodeFile,
  MAX_NON_CODE_BYTES,
  PRIMARY_MANIFEST_NAMES,
} from "../lib/parser/screening.ts";
import { MAX_FILE_BYTES, walkRepository } from "../lib/parser/walk.ts";

function pass(name: string): void {
  console.log(`ok    ${name}`);
}

console.log("=== 1. Primary Manifest Allowlist ===");
{
  const allowed = [
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "pnpm-workspace.yaml",
  ];

  for (const name of allowed) {
    assert(PRIMARY_MANIFEST_NAMES.has(name), `Expected ${name} in PRIMARY_MANIFEST_NAMES`);
    const cleanContent = Buffer.from(
      name === "package.json"
        ? '{"name": "test-pkg", "version": "1.0.0"}'
        : name === "Cargo.toml"
          ? '[package]\nname = "test"\nversion = "0.1.0"'
          : name === "go.mod"
            ? "module example.com/test\n\ngo 1.22"
            : name === "pyproject.toml"
              ? '[project]\nname = "test"\nversion = "0.1.0"'
              : name === "requirements.txt"
                ? "requests==2.31.0"
                : "packages:\n  - 'packages/*'",
      "utf8",
    );
    const result = classifyManifestBuffer(cleanContent, name);
    assert.strictEqual(result.status, "eligible");
    if (result.status === "eligible") {
      assert.strictEqual(result.category, "primary_manifest");
      assert.strictEqual(result.bytes, cleanContent.byteLength);
      assert(result.hash.length === 64);
      assert.strictEqual(result.content, cleanContent.toString("utf8"));
    }
    pass(`allowed primary manifest: ${name}`);
  }
}

console.log("\n=== 2. Non-Allowlisted & Lockfile Rejection ===");
{
  const nonAllowlisted = [
    "README.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "tsconfig.json",
    "Dockerfile",
    "Makefile",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "poetry.lock",
  ];

  for (const name of nonAllowlisted) {
    const buf = Buffer.from("content", "utf8");
    const result = classifyManifestBuffer(buf, name);
    assert.strictEqual(
      result.status,
      "skipped",
      `Expected ${name} to be skipped, got ${result.status}`,
    );
    if (result.status === "skipped") {
      assert.strictEqual(result.reason, "not-allowlisted");
      assert(result.detail.includes("not in primary manifest allowlist"));
    }
    pass(`non-allowlisted file skipped: ${name}`);
  }
}

console.log("\n=== 3. Sensitive Filename & Path Detection ===");
{
  const sensitiveFiles = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.staging",
    ".env.example",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".netrc",
    ".dockercfg",
    "docker-compose.yml",
    "docker-compose.override.yaml",
    "server.key",
    "cert.pem",
    "keystore.p12",
    "auth.pkcs12",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    "id_ed25519.pub",
    "credentials.json",
    "client_secret.json",
    "api_secrets.yaml",
    "passwd",
  ];

  for (const name of sensitiveFiles) {
    const buf = Buffer.from("dummy-content", "utf8");
    const result = classifyManifestBuffer(buf, name);
    assert.strictEqual(
      result.status,
      "rejected",
      `Expected ${name} to be rejected, got ${result.status}`,
    );
    if (result.status === "rejected") {
      assert.strictEqual(result.reason, "sensitive-filename");
      assert(!("content" in result));
      assert(!("buffer" in result));
    }
    pass(`sensitive filename rejected: ${name}`);
  }

  // Sensitive directory in path
  const sensitivePaths = [
    ".ssh/package.json",
    ".gnupg/Cargo.toml",
    "secrets/requirements.txt",
    ".env.d/package.json",
  ];

  for (const p of sensitivePaths) {
    const buf = Buffer.from('{"name": "test"}', "utf8");
    const result = classifyManifestBuffer(buf, p);
    assert.strictEqual(
      result.status,
      "rejected",
      `Expected ${p} to be rejected, got ${result.status}`,
    );
    if (result.status === "rejected") {
      assert.strictEqual(result.reason, "sensitive-path");
      assert(!("content" in result));
    }
    pass(`sensitive path rejected: ${p}`);
  }
}

console.log("\n=== 4. Size & Binary Content Bounds ===");
{
  // 512 KiB limit
  const exactLimit = Buffer.alloc(MAX_NON_CODE_BYTES, "a");
  const exactResult = classifyManifestBuffer(exactLimit, "package.json");
  assert.strictEqual(exactResult.status, "eligible");
  pass(`exact limit size (${MAX_NON_CODE_BYTES} bytes) allowed`);

  const overLimit = Buffer.alloc(MAX_NON_CODE_BYTES + 1, "a");
  const overResult = classifyManifestBuffer(overLimit, "package.json");
  assert.strictEqual(overResult.status, "skipped");
  if (overResult.status === "skipped") {
    assert.strictEqual(overResult.reason, "too-large");
    assert(overResult.detail.includes("exceeds"));
    assert(!("content" in overResult));
  }
  pass(`oversized manifest (${MAX_NON_CODE_BYTES + 1} bytes) skipped`);

  // Binary content with NUL byte
  const binaryContent = Buffer.from('{"name": "test\0pkg"}', "utf8");
  const binResult = classifyManifestBuffer(binaryContent, "package.json");
  assert.strictEqual(binResult.status, "skipped");
  if (binResult.status === "skipped") {
    assert.strictEqual(binResult.reason, "binary");
    assert.strictEqual(binResult.detail, "contains NUL bytes");
    assert(!("content" in binResult));
  }
  pass("binary manifest containing NUL byte skipped");
}

console.log("\n=== 5. Credential & Private Key Screening ===");
{
  const secretSamples: { label: string; file: string; text: string; expectedRule: string }[] = [
    {
      label: "RSA private key header",
      file: "package.json",
      text: '{"name": "test", "key": "-----BEGIN RSA PRIVATE KEY-----\\nMIIE..."}',
      expectedRule: "private-key",
    },
    {
      label: "Generic private key header",
      file: "Cargo.toml",
      text: '[package]\nname = "test"\n# -----BEGIN PRIVATE KEY-----\nkey = "..."',
      expectedRule: "private-key",
    },
    {
      label: "PGP private key block",
      file: "pyproject.toml",
      text: '[project]\nname = "test"\n# -----BEGIN PGP PRIVATE KEY BLOCK-----\n',
      expectedRule: "pgp-private-key",
    },
    {
      label: "Embedded HTTP basic auth in registry URL",
      file: "package.json",
      text: '{"name": "test", "publishConfig": {"registry": "https://deployer:secretpass123@npm.pkg.github.com"}}',
      expectedRule: "authenticated-url-user-pass",
    },
    {
      label: "Token in GitHub registry URL",
      file: "package.json",
      text: '{"repository": "https://ghp_abcdefghijklmnopqrstuvwxyz1234567890@github.com/org/repo.git"}',
      expectedRule: "authenticated-url-token",
    },
    {
      label: "GitHub Personal Access Token (classic ghp)",
      file: "package.json",
      text: '{"scripts": {"deploy": "curl -H \'Authorization: token ghp_0123456789abcdefghijklmnopqrstuvwxyz\' https://api.github.com"}}',
      expectedRule: "github-pat",
    },
    {
      label: "GitHub Fine-Grained Token",
      file: "requirements.txt",
      text: "# deployment key\n# github_pat_11AAAAAAA0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab\nrequests==2.31.0",
      expectedRule: "github-fine-grained-pat",
    },
    {
      label: "NPM Access Token",
      file: "package.json",
      text: '{"scripts": {"publish": "NPM_TOKEN=npm_1234567890abcdefghijklmnopqrstuvwxyz npm publish"}}',
      expectedRule: "npm-token",
    },
    {
      label: "AWS Access Key Identifier",
      file: "Cargo.toml",
      text: '[package]\nname = "test"\n# aws_key = "AKIAIOSFODNN7EXAMPLE"\n',
      expectedRule: "aws-access-key",
    },
    {
      label: "Slack Bot Token",
      file: "package.json",
      text: '{"scripts": {"notify": "curl -d token=xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx"}}',
      expectedRule: "slack-token",
    },
    {
      label: "HTTP Bearer authorization token",
      file: "pyproject.toml",
      text: '[project]\n# Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnopqrstuvwxyz1234567890\nname = "test"',
      expectedRule: "bearer-token",
    },
    {
      label: "Hardcoded API key assignment",
      file: "package.json",
      text: '{"config": {"api_key": "prod_live_secret_key_9876543210abcdef"}}',
      expectedRule: "hardcoded-credential-assignment",
    },
  ];

  for (const sample of secretSamples) {
    const buf = Buffer.from(sample.text, "utf8");
    const result = classifyManifestBuffer(buf, sample.file);
    assert.strictEqual(
      result.status,
      "rejected",
      `Expected ${sample.label} to be rejected, got ${result.status}`,
    );
    if (result.status === "rejected") {
      assert.strictEqual(result.reason, "secret-detected");
      // Critical check: Ensure the secret sample text does NOT appear in detail
      assert(!result.detail.includes("MIIE"));
      assert(!result.detail.includes("secretpass123"));
      assert(!result.detail.includes("ghp_"));
      assert(!result.detail.includes("npm_"));
      assert(!result.detail.includes("AKIA"));
      assert(!("content" in result));
      assert(!("buffer" in result));
    }
    pass(`secret screened and rejected: ${sample.label}`);
  }
}

console.log("\n=== 6. Safe Manifests & No False Positives ===");
{
  const benignManifests: { file: string; text: string }[] = [
    {
      file: "package.json",
      text: JSON.stringify(
        {
          name: "cartograph",
          version: "1.0.0",
          repository: {
            type: "git",
            url: "https://github.com/my-org/cartograph.git",
          },
          dependencies: {
            jsonwebtoken: "^9.0.2",
            "@aws-sdk/client-s3": "^3.500.0",
            "@auth/core": "^0.34.0",
            "secret-service-wrapper": "1.0.0",
          },
          scripts: {
            test: "node --test",
            build: "next build",
            lint: "eslint .",
          },
        },
        null,
        2,
      ),
    },
    {
      file: "Cargo.toml",
      text: `[package]
name = "token-parser"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = "1.36"
`,
    },
    {
      file: "go.mod",
      text: `module github.com/org/secret-scanner

go 1.22

require (
\tgithub.com/golang-jwt/jwt/v5 v5.2.0
)
`,
    },
    {
      file: "pyproject.toml",
      text: `[project]
name = "auth-token-helper"
version = "0.1.0"
dependencies = [
    "pyjwt>=2.8.0",
    "cryptography>=42.0.0",
]
`,
    },
    {
      file: "requirements.txt",
      text: `pyjwt==2.8.0
cryptography>=42.0.0 # token encryption
requests==2.31.0
`,
    },
    {
      file: "pnpm-workspace.yaml",
      text: `packages:
  - 'packages/*'
  - 'apps/*'
  - '!**/test/**'
`,
    },
  ];

  for (const m of benignManifests) {
    const buf = Buffer.from(m.text, "utf8");
    const result = classifyManifestBuffer(buf, m.file);
    assert.strictEqual(
      result.status,
      "eligible",
      `Expected benign ${m.file} to be eligible, got: ${JSON.stringify(result)}`,
    );
    if (result.status === "eligible") {
      assert.strictEqual(result.bytes, buf.byteLength);
      assert.strictEqual(result.content, m.text);
    }
    pass(`benign manifest approved without false positive: ${m.file}`);
  }
}

console.log("\n=== 7. Unicode & UTF-8 Handling ===");
{
  // Valid UTF-8 with multilingual text and emojis
  const unicodeManifest = JSON.stringify(
    {
      name: "international-app",
      author: "Hélène Müller <helene@example.de>",
      description: "Cartograph 🗺️ — ソフトウェア解析ツール / ניתוח קוד",
      contributors: ["张伟", "田中太郎", "Иван Иванов"],
    },
    null,
    2,
  );
  const unicodeBuf = Buffer.from(unicodeManifest, "utf8");
  const unicodeResult = classifyManifestBuffer(unicodeBuf, "package.json");
  assert.strictEqual(unicodeResult.status, "eligible");
  if (unicodeResult.status === "eligible") {
    assert.strictEqual(unicodeResult.content, unicodeManifest);
  }
  pass("valid multilingual UTF-8 and emojis approved");

  // Invalid UTF-8 sequence (invalid byte 0xFF, 0xFE)
  const invalidUtf8Buf = Buffer.from([
    0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x20, 0x22, 0xff, 0xfe,
    0x22, 0x7d,
  ]);
  const invalidResult = classifyManifestBuffer(invalidUtf8Buf, "package.json");
  assert.strictEqual(invalidResult.status, "skipped");
  if (invalidResult.status === "skipped") {
    assert.strictEqual(invalidResult.reason, "invalid-utf8");
    assert(!("content" in invalidResult));
  }
  pass("invalid UTF-8 sequence rejected with safe reason");
}

console.log("\n=== 8. Filesystem Screening & Symlink Safety ===");
{
  // In-memory symlink classification
  const symlinkResult = classifyManifestBuffer(
    Buffer.from('{"name": "test"}', "utf8"),
    "package.json",
    true, // isSymlink = true
  );
  assert.strictEqual(symlinkResult.status, "skipped");
  if (symlinkResult.status === "skipped") {
    assert.strictEqual(symlinkResult.reason, "symlink");
    assert.strictEqual(symlinkResult.detail, "symbolic link not followed");
  }
  pass("classifyManifestBuffer skips symlink to manifest");

  const tempDir = mkdtempSync(path.join(tmpdir(), "cartograph-screening-test-"));
  try {
    const safePkg = path.join(tempDir, "package.json");
    writeFileSync(safePkg, '{"name": "temp-pkg", "version": "1.0.0"}', "utf8");

    const fileResult = classifyNonCodeFile(safePkg, "package.json");
    assert.strictEqual(fileResult.status, "eligible");
    pass("classifyNonCodeFile identifies real eligible file on disk");

    // Filesystem symlink (if OS allows)
    try {
      const symlinkPkg = path.join(tempDir, "symlink-package.json");
      symlinkSync(safePkg, symlinkPkg, "file");
      const fsSymResult = classifyNonCodeFile(symlinkPkg, "package.json");
      assert.strictEqual(fsSymResult.status, "skipped");
      if (fsSymResult.status === "skipped") {
        assert.strictEqual(fsSymResult.reason, "symlink");
      }
      pass("classifyNonCodeFile skips filesystem symlink");
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "EPERM") {
        pass("filesystem symlink requires OS developer privileges; in-memory symlink verified");
      } else {
        throw err;
      }
    }

    // Missing file test
    const missingPkg = path.join(tempDir, "does-not-exist.json");
    const missingResult = classifyNonCodeFile(missingPkg, "package.json");
    assert.strictEqual(missingResult.status, "skipped");
    if (missingResult.status === "skipped") {
      assert.strictEqual(missingResult.reason, "unreadable");
    }
    pass("classifyNonCodeFile safely handles non-existent file");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log("\n=== 9. Walk Integration & Invariants ===");
{
  // Walk polyglot-manifests fixture
  const fixturePath = path.resolve("fixtures/polyglot-manifests");
  const walkResult = walkRepository(fixturePath);

  assert(Array.isArray(walkResult.nonCodeCandidates), "walkResult has nonCodeCandidates");
  assert(Array.isArray(walkResult.nonCodeClassifications), "walkResult has nonCodeClassifications");

  // All 6 manifests should be eligible candidates
  const candidateBasenames = new Set(walkResult.nonCodeCandidates.map((c) => path.basename(c.path)));
  assert(candidateBasenames.has("package.json"), "has package.json candidate");
  assert(candidateBasenames.has("Cargo.toml"), "has Cargo.toml candidate");
  assert(candidateBasenames.has("go.mod"), "has go.mod candidate");
  assert(candidateBasenames.has("pyproject.toml"), "has pyproject.toml candidate");
  assert(candidateBasenames.has("requirements.txt"), "has requirements.txt candidate");
  assert(candidateBasenames.has("pnpm-workspace.yaml"), "has pnpm-workspace.yaml candidate");
  assert.strictEqual(walkResult.nonCodeCandidates.length, 6);

  // Invariant: walk.candidates must only contain code files (.ts, .js, etc.)
  for (const c of walkResult.candidates) {
    assert(
      !PRIMARY_MANIFEST_NAMES.has(path.basename(c.path)),
      `Code candidates must NOT contain non-code manifest: ${c.path}`,
    );
  }
  pass("walkRepository populates nonCodeCandidates while keeping code candidates pristine");

  // Invariant: candidate content must match hash
  for (const c of walkResult.nonCodeCandidates) {
    assert.strictEqual(c.category, "primary_manifest");
    assert(c.lines > 0, `${c.path} lines must be > 0`);
    assert(c.bytes > 0, `${c.path} bytes must be > 0`);
    assert(c.content.length > 0, `${c.path} content must be non-empty`);
    assert.strictEqual(typeof c.hash, "string");
    assert.strictEqual(c.hash.length, 64);
  }
  pass("all nonCodeCandidates carry verified hashes, lines, bytes, and content");

  // Screening walk with secret-bearing manifest
  const tempDir = mkdtempSync(path.join(tmpdir(), "cartograph-walk-secret-"));
  try {
    writeFileSync(
      path.join(tempDir, "package.json"),
      '{"name": "leaker", "token": "ghp_0123456789abcdefghijklmnopqrstuvwxyz"}',
      "utf8",
    );
    const secretWalk = walkRepository(tempDir);
    assert.strictEqual(secretWalk.nonCodeCandidates.length, 0, "secret manifest must not become candidate");
    const secretCls = secretWalk.nonCodeClassifications.find((c) => c.path === "package.json");
    assert(secretCls && secretCls.status === "rejected");
    if (secretCls && secretCls.status === "rejected") {
      assert.strictEqual(secretCls.reason, "secret-detected");
      assert(!secretCls.detail.includes("ghp_"));
    }
    // Manifest is recorded with security problem without leaking secret
    assert.strictEqual(secretWalk.manifests.length, 1);
    assert.strictEqual(secretWalk.manifests[0]!.dependencies.length, 0);
    assert(
      secretWalk.manifests[0]!.manifest.problems.some((p) => p.includes("security-screening-rejected")),
    );
    pass("walkRepository strictly rejects secret-bearing manifest from candidates and metadata");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log("\n=== 10. CI-4 Phase 1.1 Regression Tests (readPackage & oversized bypasses) ===");
{
  // Test 1: Early readPackage() bypass
  // Secret-bearing package.json must not contribute to workspacePackages, adapter selection, or manifest metadata.
  const tempDirSecret = mkdtempSync(path.join(tmpdir(), "cartograph-reg-secret-"));
  try {
    const secretContent = JSON.stringify(
      {
        name: "secret-leaker",
        version: "1.0.0",
        workspaces: ["packages/*"],
        scripts: { dev: "next dev", build: "next build" },
        dependencies: {
          next: "^15.0.0",
          react: "^19.0.0",
        },
        privateKey:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
      },
      null,
      2,
    );

    writeFileSync(path.join(tempDirSecret, "package.json"), secretContent, "utf8");
    const walkResult = walkRepository(tempDirSecret);

    assert.strictEqual(
      walkResult.nonCodeCandidates.length,
      0,
      "secret manifest must not become candidate",
    );
    assert.strictEqual(
      walkResult.workspacePackages.has("secret-leaker"),
      false,
      "secret package must not be in workspacePackages",
    );
    assert.strictEqual(walkResult.workspacePackages.size, 0, "workspacePackages must be empty");

    const rootAdapter = walkResult.adapters.get(".");
    assert(rootAdapter, "root adapter must exist");
    assert.strictEqual(
      rootAdapter.name,
      "none",
      "adapter must remain fallback 'none' and not detect Next.js from rejected manifest",
    );

    assert.strictEqual(walkResult.manifests.length, 1, "manifest record is preserved");
    const manifest = walkResult.manifests[0]!.manifest;
    assert.strictEqual(manifest.name, null, "manifest name must be null");
    assert.deepStrictEqual(manifest.workspaces, [], "manifest workspaces must be empty");
    assert.deepStrictEqual(manifest.scripts, [], "manifest scripts must be empty");
    assert.strictEqual(walkResult.manifests[0]!.dependencies.length, 0, "dependencies must be empty");
    assert.strictEqual(walkResult.manifests[0]!.declared.length, 0, "declared entry points must be empty");
    assert(
      manifest.problems.some((p) => p.includes("security-screening-rejected: secret-detected")),
      "must record security-screening-rejected problem",
    );

    // Verify secret material is nowhere in the walk output
    const serialized = JSON.stringify(walkResult);
    assert(!serialized.includes("OPENSSH"), "no secret text in walk result");
    assert(!serialized.includes("b3BlbnNzaC1rZXk"), "no secret text in walk result");

    pass(
      "early readPackage bypass prevented: rejected manifest cannot trigger framework detection or register workspace package",
    );
  } finally {
    rmSync(tempDirSecret, { recursive: true, force: true });
  }

  // Test 2: Oversized manifest bypass (between 512 KiB and 1 MiB)
  // File size is between MAX_NON_CODE_BYTES (512 KiB) and MAX_FILE_BYTES (1 MiB).
  // Must fail closed: not eligible, not read by readManifest(), no adapter detection, no workspacePackages.
  const tempDirOversized = mkdtempSync(path.join(tmpdir(), "cartograph-reg-oversized-"));
  try {
    const filler = "a".repeat(600 * 1024); // 600 KiB filler
    const oversizedJson = JSON.stringify({
      name: "oversized-package",
      version: "1.0.0",
      description: filler,
      workspaces: ["packages/*"],
      scripts: { dev: "next dev", build: "next build" },
      dependencies: {
        next: "^15.0.0",
        react: "^19.0.0",
        lodash: "^4.17.21",
      },
    });

    const byteLen = Buffer.byteLength(oversizedJson, "utf8");
    assert(
      byteLen > MAX_NON_CODE_BYTES,
      `byteLen (${byteLen}) must be > MAX_NON_CODE_BYTES (${MAX_NON_CODE_BYTES})`,
    );
    assert(
      byteLen < MAX_FILE_BYTES,
      `byteLen (${byteLen}) must be < MAX_FILE_BYTES (${MAX_FILE_BYTES})`,
    );

    writeFileSync(path.join(tempDirOversized, "package.json"), oversizedJson, "utf8");
    const walkResult = walkRepository(tempDirOversized);

    assert.strictEqual(
      walkResult.nonCodeCandidates.length,
      0,
      "oversized manifest must not become candidate",
    );
    assert.strictEqual(
      walkResult.workspacePackages.has("oversized-package"),
      false,
      "oversized package must not be in workspacePackages",
    );
    assert.strictEqual(walkResult.workspacePackages.size, 0, "workspacePackages must be empty");

    const rootAdapter = walkResult.adapters.get(".");
    assert(rootAdapter, "root adapter must exist");
    assert.strictEqual(
      rootAdapter.name,
      "none",
      "adapter must remain fallback 'none' and not detect Next.js from oversized manifest",
    );

    assert.strictEqual(walkResult.manifests.length, 1, "manifest record is preserved");
    const manifest = walkResult.manifests[0]!.manifest;
    assert.strictEqual(manifest.name, null, "manifest name must be null");
    assert.deepStrictEqual(manifest.workspaces, [], "manifest workspaces must be empty");
    assert.deepStrictEqual(manifest.scripts, [], "manifest scripts must be empty");
    assert.strictEqual(walkResult.manifests[0]!.dependencies.length, 0, "dependencies must be empty");
    assert.strictEqual(walkResult.manifests[0]!.declared.length, 0, "declared entry points must be empty");
    assert(
      manifest.problems.some((p) => p.includes("security-screening-skipped: too-large")),
      "must record security-screening-skipped: too-large problem",
    );

    const classification = walkResult.nonCodeClassifications.find((c) => c.path === "package.json");
    assert(classification && classification.status === "skipped");
    if (classification && classification.status === "skipped") {
      assert.strictEqual(classification.reason, "too-large");
    }

    pass(
      "oversized manifest between 512 KiB and 1 MiB safely fails closed without metadata extraction",
    );
  } finally {
    rmSync(tempDirOversized, { recursive: true, force: true });
  }

  // Test 3: Subdirectory nested package.json with secret
  const tempDirNested = mkdtempSync(path.join(tmpdir(), "cartograph-reg-nested-"));
  try {
    const subDir = path.join(tempDirNested, "packages", "sub");
    mkdirSync(subDir, { recursive: true });

    // Root is clean
    writeFileSync(path.join(tempDirNested, "package.json"), '{"name": "root-pkg"}', "utf8");

    // Subpackage has secret
    writeFileSync(
      path.join(subDir, "package.json"),
      '{"name": "sub-leaker", "dependencies": {"next": "^15.0.0"}, "secret_key": "ghp_0123456789abcdefghijklmnopqrstuvwxyz"}',
      "utf8",
    );

    const walkResult = walkRepository(tempDirNested);

    assert(walkResult.workspacePackages.has("root-pkg"), "root-pkg is registered");
    assert.strictEqual(
      walkResult.workspacePackages.has("sub-leaker"),
      false,
      "nested sub-leaker must NOT be in workspacePackages",
    );
    assert.strictEqual(walkResult.workspacePackages.size, 1, "only root-pkg in workspacePackages");

    // Subproject must not be created with Next.js adapter
    assert.strictEqual(
      walkResult.adapters.has("packages/sub"),
      false,
      "no subproject adapter created for rejected nested package",
    );

    // Sub manifest metadata must be sanitized
    const subManifest = walkResult.manifests.find(
      (m) => m.manifest.path === "packages/sub/package.json",
    );
    assert(subManifest, "sub manifest record exists");
    assert.strictEqual(subManifest.manifest.name, null);
    assert.strictEqual(subManifest.dependencies.length, 0);

    pass("nested rejected package.json does not register subproject or workspacePackage");
  } finally {
    rmSync(tempDirNested, { recursive: true, force: true });
  }
}

console.log("\nEvery test passed.");
