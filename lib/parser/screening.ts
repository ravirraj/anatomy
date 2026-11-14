// Bounded, deny-by-default classification and security screening for selected
// non-code repository files (primary repository manifests).
//
// Invariants enforced here:
//   1. Explicit allowlist: only primary manifest files are eligible.
//   2. Size bound: candidate files must not exceed MAX_NON_CODE_BYTES (512 KiB).
//   3. Deny-by-default: sensitive filenames, sensitive paths, and symlinks are rejected.
//   4. Binary exclusion: NUL-byte containing files are rejected.
//   5. Encoding verification: candidate files must strictly decode to valid UTF-8.
//   6. Content screening: embedded credentials, private keys, and authenticated
//      registry URLs are blocked before candidate approval.
//   7. Redaction guarantee: rejected files never retain raw content or buffers,
//      and diagnostic details never leak offending secret values.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { countLines } from "./walk.ts";

/** Primary manifest filenames eligible for candidate discovery in Phase 1. */
export const PRIMARY_MANIFEST_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "pnpm-workspace.yaml",
]);

/** Maximum size permitted for an eligible non-code manifest file (512 KiB). */
export const MAX_NON_CODE_BYTES = 512 * 1024;

export type NonCodeCategory = "primary_manifest";

export type NonCodeRejectReason =
  | "secret-detected"
  | "sensitive-filename"
  | "sensitive-path";

export type NonCodeSkipReason =
  | "not-allowlisted"
  | "symlink"
  | "unreadable"
  | "too-large"
  | "binary"
  | "invalid-utf8";

/** An approved, security-screened non-code candidate file. */
export type NonCodeCandidate = {
  path: string;
  absolutePath: string;
  module: string;
  content: string;
  bytes: number;
  lines: number;
  hash: string;
  project: string;
  category: NonCodeCategory;
};

/**
 * Structured classification outcome for non-code files.
 *
 * Notice: Rejected and skipped outcomes deliberately omit content and buffer
 * so that unapproved or sensitive content cannot leak into downstream records,
 * debug logs, or error responses.
 */
export type CandidateClassification =
  | {
      status: "eligible";
      path: string;
      category: NonCodeCategory;
      bytes: number;
      lines: number;
      hash: string;
      content: string;
    }
  | {
      status: "rejected";
      path: string;
      reason: NonCodeRejectReason;
      detail: string;
    }
  | {
      status: "skipped";
      path: string;
      reason: NonCodeSkipReason;
      detail: string;
    };

export type SecretCheckResult =
  | { safe: true }
  | { safe: false; rule: string; detail: string };

const SENSITIVE_EXTENSIONS = new Set([
  ".pem", ".key", ".pkcs12", ".pfx", ".p12", ".crt", ".cer", ".der", ".kdbx",
]);

const SENSITIVE_SPECIFIC_NAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".netrc",
  ".dockercfg",
]);

/**
 * High-risk credential and secret detection rules.
 *
 * Descriptions and rules are static. Neither matched secret tokens nor surrounding
 * file lines are included in the returned outcome.
 */
const SECRET_DETECTORS: readonly { rule: string; detail: string; pattern: RegExp }[] = [
  // 1. Private key blocks (RSA, EC, OpenSSH, PGP, generic private key)
  {
    rule: "private-key",
    detail: "private key header detected",
    pattern: /-----BEGIN(?:[ A-Z0-9_-]+)?\s+PRIVATE KEY-----/i,
  },
  {
    rule: "pgp-private-key",
    detail: "PGP private key block detected",
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/i,
  },
  // 2. Authenticated registry URLs:
  // e.g. https://user:password@registry.npmjs.org/ or https://token@npm.pkg.github.com/
  {
    rule: "authenticated-url-user-pass",
    detail: "authenticated URL with embedded user/password credentials detected",
    pattern: /\bhttps?:\/\/[^\s/@:]+:[^\s/@:]+@[^\s/]+/i,
  },
  {
    rule: "authenticated-url-token",
    detail: "authenticated registry URL with embedded token credentials detected",
    pattern: /\bhttps?:\/\/[^\s/@]+@(?:github\.com|gitlab\.com|bitbucket\.org|npm\.pkg\.github\.com|[a-zA-Z0-9.-]+\.pkgs\.visualstudio\.com|[a-zA-Z0-9.-]+\.jfrog\.io|[a-zA-Z0-9.-]+\.pypi\.org)/i,
  },
  {
    rule: "protocol-relative-auth-url",
    detail: "protocol-relative authenticated registry URL detected",
    pattern: /\/\/[^\s/@:]+:[^\s/@:]+@[^\s/]+/,
  },
  // 3. Well-known credential token prefixes
  {
    rule: "github-pat",
    detail: "GitHub Personal Access Token detected",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/,
  },
  {
    rule: "github-fine-grained-pat",
    detail: "GitHub fine-grained access token detected",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{50,255}\b/,
  },
  {
    rule: "npm-token",
    detail: "NPM access token detected",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
  },
  {
    rule: "aws-access-key",
    detail: "AWS access key identifier detected",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    rule: "slack-token",
    detail: "Slack token detected",
    pattern: /\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/,
  },
  {
    rule: "bearer-token",
    detail: "HTTP Bearer authorization token detected",
    pattern: /\bBearer\s+[A-Za-z0-9._\-]{30,}\b/i,
  },
  // 4. Hardcoded credential assignments in key-value structures
  // Avoids matching template expressions ($VAR, {{...}}, process.env)
  {
    rule: "hardcoded-credential-assignment",
    detail: "hardcoded credential key-value assignment detected",
    pattern: /(?:"|')?(?:api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|secret[_-]?key|password)(?:"|')?\s*[:=]\s*["'](?!(?:\$|\{\{|process\.env|\benv\b))[A-Za-z0-9+\/=_.~-]{16,}["']/i,
  },
];

/**
 * Checks a path and its filename against known sensitive patterns.
 */
export function checkSensitivePath(relativePath: string): { sensitive: boolean; reason?: NonCodeRejectReason; detail?: string } {
  const norm = relativePath.split(path.sep).join("/");
  const fileName = norm.split("/").pop() ?? norm;
  const lowerName = fileName.toLowerCase();

  // 1. Environment files
  if (lowerName === ".env" || lowerName.startsWith(".env.") || lowerName.startsWith(".env_")) {
    return { sensitive: true, reason: "sensitive-filename", detail: "environment file matches sensitive pattern" };
  }

  // 2. Package manager auth & network credentials
  if (SENSITIVE_SPECIFIC_NAMES.has(lowerName)) {
    return { sensitive: true, reason: "sensitive-filename", detail: "configuration file matches sensitive credential pattern" };
  }

  // 3. Private keys & certificates by extension
  const ext = path.extname(lowerName);
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return { sensitive: true, reason: "sensitive-filename", detail: "file extension matches sensitive key/certificate pattern" };
  }

  // 4. SSH keys
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(fileName)) {
    return { sensitive: true, reason: "sensitive-filename", detail: "filename matches SSH key pattern" };
  }

  // 5. Explicit secret / credential keywords in filename
  if (/(?:secret|credential|passwd|shadow|htpasswd)/i.test(fileName)) {
    return { sensitive: true, reason: "sensitive-filename", detail: "filename contains sensitive keyword" };
  }

  // 6. Docker compose with potential environment secrets
  if (/^docker-compose(?:[-.][a-z0-9_-]+)?\.ya?ml$/i.test(fileName)) {
    return { sensitive: true, reason: "sensitive-filename", detail: "docker-compose file matches sensitive configuration pattern" };
  }

  // 7. Sensitive directories in relative path
  const parts = norm.split("/");
  for (const part of parts.slice(0, -1)) {
    const lowerPart = part.toLowerCase();
    if (lowerPart.startsWith(".env") || lowerPart === ".ssh" || lowerPart === ".gnupg" || lowerPart === "secrets") {
      return { sensitive: true, reason: "sensitive-path", detail: "path contains sensitive directory" };
    }
  }

  return { sensitive: false };
}

/**
 * Screens decoded text content against credential and secret patterns.
 * Never includes matched sensitive text in the returned result.
 */
export function screenManifestContent(content: string): SecretCheckResult {
  for (const detector of SECRET_DETECTORS) {
    if (detector.pattern.test(content)) {
      return { safe: false, rule: detector.rule, detail: detector.detail };
    }
  }
  return { safe: true };
}

/**
 * Classifies an in-memory buffer for a given relative path.
 *
 * Verifies size bounds, binary neutrality, UTF-8 decodability, filename eligibility,
 * and content security.
 */
export function classifyManifestBuffer(
  buffer: Buffer,
  relativePath: string,
  isSymlink = false,
): CandidateClassification {
  const norm = relativePath.split(path.sep).join("/");
  const fileName = norm.split("/").pop() ?? norm;

  // 1. Path sensitivity check
  const pathCheck = checkSensitivePath(norm);
  if (pathCheck.sensitive) {
    return {
      status: "rejected",
      path: norm,
      reason: pathCheck.reason ?? "sensitive-filename",
      detail: pathCheck.detail ?? "matches sensitive pattern",
    };
  }

  // 2. Allowlist check
  if (!PRIMARY_MANIFEST_NAMES.has(fileName)) {
    return {
      status: "skipped",
      path: norm,
      reason: "not-allowlisted",
      detail: `${fileName} is not in primary manifest allowlist`,
    };
  }

  // 3. Symlink check
  if (isSymlink) {
    return {
      status: "skipped",
      path: norm,
      reason: "symlink",
      detail: "symbolic link not followed",
    };
  }

  // 4. Size check
  if (buffer.byteLength > MAX_NON_CODE_BYTES) {
    return {
      status: "skipped",
      path: norm,
      reason: "too-large",
      detail: `file size (${buffer.byteLength} bytes) exceeds ${MAX_NON_CODE_BYTES} byte limit`,
    };
  }

  // 5. Binary check (NUL bytes)
  if (buffer.includes(0)) {
    return {
      status: "skipped",
      path: norm,
      reason: "binary",
      detail: "contains NUL bytes",
    };
  }

  // 6. UTF-8 decodability verification (exact round-trip check)
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) {
    return {
      status: "skipped",
      path: norm,
      reason: "invalid-utf8",
      detail: "file does not decode to valid UTF-8",
    };
  }

  // 7. Content secret screening
  const screenResult = screenManifestContent(text);
  if (!screenResult.safe) {
    return {
      status: "rejected",
      path: norm,
      reason: "secret-detected",
      detail: screenResult.detail,
    };
  }

  // 8. Approved eligible candidate
  return {
    status: "eligible",
    path: norm,
    category: "primary_manifest",
    bytes: buffer.byteLength,
    lines: countLines(text),
    hash: createHash("sha256").update(buffer).digest("hex"),
    content: text,
  };
}

/**
 * Classifies a filesystem file, returning a structured candidate classification.
 */
export function classifyNonCodeFile(
  absolutePath: string,
  relativePath: string,
): CandidateClassification {
  const norm = relativePath.split(path.sep).join("/");
  const fileName = norm.split("/").pop() ?? norm;

  // 1. Path sensitivity check
  const pathCheck = checkSensitivePath(norm);
  if (pathCheck.sensitive) {
    return {
      status: "rejected",
      path: norm,
      reason: pathCheck.reason ?? "sensitive-filename",
      detail: pathCheck.detail ?? "matches sensitive pattern",
    };
  }

  // 2. Allowlist check
  if (!PRIMARY_MANIFEST_NAMES.has(fileName)) {
    return {
      status: "skipped",
      path: norm,
      reason: "not-allowlisted",
      detail: `${fileName} is not in primary manifest allowlist`,
    };
  }

  // 3. Symlink and file existence check
  let stat;
  try {
    stat = lstatSync(absolutePath, { throwIfNoEntry: false });
  } catch {
    return {
      status: "skipped",
      path: norm,
      reason: "unreadable",
      detail: "file stat failed",
    };
  }

  if (!stat) {
    return {
      status: "skipped",
      path: norm,
      reason: "unreadable",
      detail: "file does not exist",
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      status: "skipped",
      path: norm,
      reason: "symlink",
      detail: "symbolic link not followed",
    };
  }

  // 4. File read
  let buffer: Buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch {
    return {
      status: "skipped",
      path: norm,
      reason: "unreadable",
      detail: "file could not be read",
    };
  }

  // Delegate buffer classification
  return classifyManifestBuffer(buffer, norm, false);
}
