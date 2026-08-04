#!/usr/bin/env node
/**
 * Licence check.
 *
 * Part of the zero-cost policy in docs/zero-cost-operation.md: the platform
 * must never depend on something that would require a paid or commercial
 * licence for this project's use.
 *
 * Runs entirely offline against the installed dependency tree. It contacts no
 * registry and no external service, so it costs nothing and works air-gapped.
 *
 *   node scripts/check-licences.mjs          # fail on a disallowed licence
 *   node scripts/check-licences.mjs --list   # print every licence found
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Permissive licences that place no cost or copyleft burden on this project. */
const ALLOWED = [
  /^MIT$/i,
  /^MIT\/X11$/i,
  /^MIT-0$/i,
  /^ISC$/i,
  /^0BSD$/i,
  /^BSD-2-Clause$/i,
  /^BSD-3-Clause$/i,
  /^Apache-2\.0$/i,
  /^Unlicense$/i,
  /^CC0-1\.0$/i,
  /^CC-BY-4\.0$/i,
  /^Python-2\.0$/i,
  /^BlueOak-1\.0\.0$/i,
  /^Zlib$/i,
  /^WTFPL$/i,
];

/**
 * File-level copyleft licences, accepted only where the obligation demonstrably
 * does not reach this project's own source. These are reported separately from
 * the permissive list rather than folded into it, because the distinction is
 * real and a future reader deserves to see it.
 *
 * MPL-2.0 requires that modifications *to MPL-covered files* be published under
 * the same licence. It says nothing about separate files that merely use them,
 * so consuming an unmodified MPL package places no obligation on this
 * repository. It is free software, costs nothing, and needs no commercial
 * licence for any use this project makes of it.
 */
const ALLOWED_WEAK_COPYLEFT = [
  {
    pattern: /^MPL-2\.0$/i,
    reason:
      'File-level copyleft. Consumed unmodified as a development dependency, ' +
      'so the reciprocity obligation never reaches this project’s own files. ' +
      'Free of charge, no commercial licence required.',
  },
];

/**
 * Licences that are outright disqualifying: they either cost money or impose
 * obligations incompatible with this project's intended use.
 */
const FORBIDDEN = [
  /commercial/i,
  /proprietary/i,
  /^SEE LICEN[CS]E/i,
  /^UNLICENSED$/i, // npm's marker for "explicitly not licensed for reuse"
  /BUSL/i, // Business Source Licence — converts to paid use
  /^Elastic/i,
  /^SSPL/i,
  /^AGPL/i,
  /^GPL-[23]/i, // Bare GPL. A dual "(MIT OR GPL)" is fine and handled below.
];

/**
 * Transitive packages that declare no licence at all. An absent declaration is
 * an ambiguity, not a commercial requirement, so each is recorded here with the
 * reason it is tolerated rather than failing the build silently.
 */
const KNOWN_UNDECLARED = {
  buffers:
    'No licence field. Transitive via exceljs > unzipper > binary. Upstream ' +
    '(substack/node-buffers) is conventionally MIT but this version does not ' +
    'declare it. No cost implication; see docs/zero-cost-operation.md.',
};

function collect() {
  const root = 'node_modules/.pnpm';
  const found = new Map();

  const readPackage = (dir) => {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) return;
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!pkg.name || !pkg.version) return;
      const licence =
        typeof pkg.license === 'string'
          ? pkg.license
          : pkg.license?.type ||
            (Array.isArray(pkg.licenses) && pkg.licenses.map((l) => l.type).join(' OR ')) ||
            'UNDECLARED';
      if (!found.has(pkg.name)) found.set(pkg.name, licence);
    } catch {
      // A malformed manifest in the store is not this check's concern.
    }
  };

  const scan = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith('@')) scan(path);
      else readPackage(path);
    }
  };

  if (!existsSync(root)) {
    console.error('node_modules/.pnpm not found. Run pnpm install first.');
    process.exit(2);
  }
  for (const dir of readdirSync(root)) {
    scan(join(root, dir, 'node_modules'));
  }
  return found;
}

/** Returns the weak-copyleft entry covering this licence, if there is one. */
function weakCopyleft(licence) {
  return ALLOWED_WEAK_COPYLEFT.find((entry) => entry.pattern.test(licence.trim()));
}

/** A dual licence passes when any one of its options is allowed. */
function isAllowed(licence) {
  const options = licence
    .replace(/[()]/g, '')
    .split(/\s+(?:OR|AND)\s+/i)
    .map((part) => part.trim());
  const permitted = options.filter((option) => ALLOWED.some((re) => re.test(option)));
  if (licence.toUpperCase().includes(' AND ')) return permitted.length === options.length;
  return permitted.length > 0;
}

const packages = collect();
const listOnly = process.argv.includes('--list');

const violations = [];
const undeclared = [];
const weak = [];
const byLicence = new Map();

for (const [name, licence] of packages) {
  byLicence.set(licence, (byLicence.get(licence) ?? 0) + 1);

  if (FORBIDDEN.some((re) => re.test(licence)) && !isAllowed(licence)) {
    violations.push({ name, licence, reason: 'disallowed licence' });
    continue;
  }
  if (licence === 'UNDECLARED') {
    if (!(name in KNOWN_UNDECLARED)) {
      violations.push({ name, licence, reason: 'no licence declared and not on the known list' });
    } else {
      undeclared.push(name);
    }
    continue;
  }
  if (isAllowed(licence)) continue;

  const concession = weakCopyleft(licence);
  if (concession) {
    weak.push({ name, licence, reason: concession.reason });
    continue;
  }
  violations.push({ name, licence, reason: 'licence not on the permissive allow-list' });
}

if (listOnly) {
  console.log(`${packages.size} packages\n`);
  for (const [licence, count] of [...byLicence].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(5)}  ${licence}`);
  }
  console.log();
}

console.log(`Licence check: ${packages.size} packages examined.`);

if (undeclared.length > 0) {
  console.log(
    `\n${undeclared.length} package(s) declare no licence, each accepted for a stated reason:`,
  );
  for (const name of undeclared) console.log(`  - ${name}: ${KNOWN_UNDECLARED[name]}`);
}

if (weak.length > 0) {
  console.log(`\n${weak.length} package(s) under file-level copyleft, each accepted for a reason:`);
  for (const entry of weak) console.log(`  - ${entry.name} (${entry.licence}): ${entry.reason}`);
}

if (violations.length > 0) {
  console.error(`\n${violations.length} licence violation(s):`);
  for (const violation of violations) {
    console.error(`  - ${violation.name}: "${violation.licence}" (${violation.reason})`);
  }
  console.error(
    '\nThis project must not depend on anything requiring a paid or commercial licence.\n' +
      'Remove the dependency, replace it, or — if the licence is genuinely permissive —\n' +
      'add it to ALLOWED in scripts/check-licences.mjs with a note explaining why.',
  );
  process.exit(1);
}

console.log('\nNothing here requires a payment or a commercial licence.');
