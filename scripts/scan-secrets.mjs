#!/usr/bin/env node
// Simple repository secrets scan (Phase 12 B, D199): tracked files only (git ls-files), or the directory given as argv[2].
// Flags likely credentials; exits 1 on findings. Allow a line with `secret-scan: allow` (test fixtures, documented dev defaults).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RULES = [
  ['AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe/Razorpay live key', /\b(sk_live_[0-9A-Za-z]{16,}|rzp_live_[0-9A-Za-z]{10,})\b/],
  ['Anthropic/OpenAI key', /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,})\b/],
  ['Worko API key', /\bwk_[a-z0-9]{10}_[A-Za-z0-9_-]{32,}\b/],
  ['credential in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:(?!postgres@|password@|\$\{|<)[^\s@/'"]{8,}@/],
  ['generic secret assignment', /\b(secret|password|api[_-]?key|token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/i],
];
const SKIP = /(^|\/)(node_modules|dist|\.git|\.turbo|coverage|build|android|ios)\//;
const BINARY = /\.(png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|apk|aab|jar|keystore|lock|sqlite)$/i;

function files(root) {
  if (process.argv[2]) {
    const out = [];
    const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (SKIP.test(p + '/')) continue; statSync(p).isDirectory() ? walk(p) : out.push(p); } };
    walk(root);
    return out;
  }
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).map((f) => join(root, f));
}

const root = process.argv[2] ?? process.cwd();
const findings = [];
for (const f of files(root)) {
  if (SKIP.test(f) || BINARY.test(f) || f.endsWith('pnpm-lock.yaml')) continue;
  let text;
  try { if (statSync(f).size > 2_000_000) continue; text = readFileSync(f, 'utf8'); } catch { continue; }
  text.split('\n').forEach((line, i) => {
    if (line.includes('secret-scan: allow')) return;
    const testFile = /(\/test\/|\.test\.tsx?$)/.test(f);
    for (const [name, re] of RULES) if (!(testFile && name === 'generic secret assignment') && re.test(line)) findings.push(`${relative(root, f)}:${i + 1}: ${name}`);
  });
}
if (findings.length) { console.error(`Possible secrets (${findings.length}):\n${findings.join('\n')}`); process.exit(1); }
console.warn('secret scan: clean');
