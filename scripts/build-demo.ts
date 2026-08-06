import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

/**
 * Builds the public demonstration page.
 *
 * The calculation engine is the one part of the platform with no server
 * dependency: no database, no session, no API. That makes it the one part that
 * can be shown honestly as a static page — the real engine, computing real
 * cash flows in the reader's browser, rather than screenshots or a mock.
 *
 * The output is a single self-contained HTML file. The engine is bundled and
 * inlined rather than loaded as a second request, so the page works from a
 * file:// URL, from GitHub Pages, or from anywhere else it is dropped, with no
 * external host involved. Nothing it does reaches the network.
 *
 *   pnpm build:demo          # writes demo/dist/index.html
 *
 * ## What this is not
 *
 * It is not the platform, and the page says so above the fold. Persistence,
 * authentication, the audit log, imports, reports and permissions all need the
 * server. Anyone reading the page should come away knowing which part they are
 * looking at.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const demo = join(root, 'demo');
const dist = join(demo, 'dist');

/**
 * The bundle entry, written and removed here rather than kept in the tree.
 *
 * It exists only to name what the page needs on `window`; leaving a file whose
 * whole purpose is three exports would invite someone to import from it.
 */
const ENTRY = `
import { calculate, ENGINE_VERSION } from '../packages/calculation-engine/src/engine.js';
import { ALL_FIXTURES } from '../packages/calculation-engine/src/__fixtures__/properties.js';
(globalThis as unknown as Record<string, unknown>).CRE = { calculate, ALL_FIXTURES, ENGINE_VERSION };
`;

const entryPath = join(demo, 'entry.generated.ts');
const bundlePath = join(demo, 'engine.generated.js');

/**
 * The rent this page must produce, worked out from the lease rather than read
 * from the engine.
 *
 * The `singleTenantIndustrial` fixture is 100,000 sf at $6.00/sf escalating 3%
 * each January, so the first five fiscal years are 600,000 and then
 * 600,000 x 1.03^n. Those figures are stated in `docs/testing-strategy.md` as
 * arithmetic anyone can check on paper; they are copied from there, never from
 * a previous run of this build. A number taken from the thing under test would
 * agree with a broken engine as readily as a working one.
 */
const EXPECTED_BASE_RENT = ['600000.00', '618000.00', '636540.00', '655636.20', '675305.29'];

/**
 * Runs the page's own script and checks that the engine inside it still works.
 *
 * This exists because of a real failure: a `$`-expansion bug in the template
 * substitution (see below) corrupted the bundle, and the build reported success
 * on a file whose script could not parse. Only opening it in a browser found
 * that. A build that cannot tell a working page from a broken one should not be
 * the last step before publishing, so it now proves three things about the file
 * it just wrote:
 *
 *   1. the bundle survived substitution byte for byte,
 *   2. the script parses and runs, and defines what the page reaches for,
 *   3. the engine it contains computes rent that matches the hand-derived
 *      figures above.
 *
 * A bare `node:vm` context is deliberate: the engine has no DOM dependency, so
 * if this ever needs a `window` to run, that is itself the finding. It is not a
 * substitute for the browser checks — layout, formatting and the page's own
 * script are not exercised here — but it does stop a corrupt engine reaching
 * Pages unnoticed.
 */
function verify(page: string, bundle: string): void {
  if (!page.includes(bundle)) {
    throw new Error(
      'The bundle was altered on its way into the page: the built file does not contain it verbatim.',
    );
  }

  const inlined = /<script>\n([\s\S]*?)\n<\/script>/.exec(page);
  if (!inlined?.[1]) {
    throw new Error('The built page has no inlined engine script to check.');
  }

  const sandbox: Record<string, unknown> = {};
  runInNewContext(inlined[1], sandbox);

  const engine = sandbox.CRE as
    | {
        calculate: (input: unknown) => { annual: { lines: Record<string, string> }[] };
        ALL_FIXTURES: Record<string, () => unknown>;
        ENGINE_VERSION: string;
      }
    | undefined;

  if (!engine?.calculate || !engine.ALL_FIXTURES || !engine.ENGINE_VERSION) {
    throw new Error('The inlined script ran but did not define window.CRE as the page expects.');
  }

  const fixture = engine.ALL_FIXTURES.singleTenantIndustrial;
  if (!fixture) {
    throw new Error(
      'The singleTenantIndustrial fixture this check relies on is no longer exported.',
    );
  }

  const annual = engine.calculate(fixture()).annual;
  const actual = EXPECTED_BASE_RENT.map((_, year) => annual[year]?.lines.potentialBaseRent);

  if (actual.join() !== EXPECTED_BASE_RENT.join()) {
    throw new Error(
      `The page's engine does not produce the rent the lease implies.\n` +
        `  expected ${EXPECTED_BASE_RENT.join(' ')}\n` +
        `  actual   ${actual.join(' ')}`,
    );
  }

  const count = Object.keys(engine.ALL_FIXTURES).length;
  if (count < 20) {
    throw new Error(`The page carries only ${count} fixtures; it is meant to carry at least 20.`);
  }

  console.warn(
    `verified — engine ${engine.ENGINE_VERSION}, ${count} fixtures, rent matches the lease.`,
  );
}

function esbuild(): string {
  // Resolved from the installed tree rather than assumed on PATH, so this runs
  // the same way locally and on a runner.
  const binary = join(root, 'node_modules', '.pnpm', 'node_modules', '.bin', 'esbuild');
  execFileSync(
    binary,
    [
      entryPath,
      '--bundle',
      '--format=iife',
      '--platform=browser',
      '--minify',
      `--outfile=${bundlePath}`,
    ],
    { stdio: 'inherit' },
  );
  return readFileSync(bundlePath, 'utf8');
}

try {
  mkdirSync(dist, { recursive: true });
  writeFileSync(entryPath, ENTRY);

  const bundle = esbuild();
  const template = readFileSync(join(demo, 'page.html'), 'utf8');

  if (!template.includes('<!--ENGINE-->')) {
    throw new Error('demo/page.html no longer has an <!--ENGINE--> placeholder to inline into.');
  }

  /*
   * Replaced with a function, not a string — this is load-bearing.
   *
   * `String.prototype.replace` expands `$` patterns in a *string* replacement:
   * `$&` is the match, `` $` `` is everything before it, `$'` everything after.
   * A minified bundle is full of `` $` `` from template literals, so passing the
   * bundle as a string silently splices the page's own head into the middle of
   * the engine and truncates it. The browser then reports
   * `SyntaxError: missing ) after argument list` from somewhere deep in zod,
   * which points nowhere near the cause.
   *
   * A replacer function receives no such treatment and inserts the text
   * verbatim. Caught by opening the built file rather than trusting the build.
   */
  const body = template.replace('<!--ENGINE-->', () => `<script>\n${bundle}\n</script>`);

  /*
   * Wrapped into a complete document here rather than in the template.
   *
   * `demo/page.html` holds body content only, because that is what the
   * Artifact publisher expects — it supplies its own doctype and head. A file
   * served by Pages has no such wrapper, and a page with no doctype triggers
   * quirks mode and no viewport meta renders at desktop width on a phone. So
   * the same template produces both, and the standalone build adds what it
   * needs. Caught by looking at the built file rather than assuming.
   */
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="The commercial real estate valuation engine, computing cash flows live in the browser across twenty regression fixtures.">
<meta name="color-scheme" content="light dark">
<style>*,*::before,*::after{box-sizing:border-box}</style>
</head>
<body>
${body}
</body>
</html>
`;
  // Checked before it is written, so a page that fails leaves nothing behind
  // for a later step to pick up and publish.
  verify(page, bundle);
  writeFileSync(join(dist, 'index.html'), page);

  const kb = Math.round(page.length / 1024);
  console.warn(`demo/dist/index.html — ${kb} kB, self-contained, no external requests.`);
} finally {
  // Generated inputs never survive the build, so a stale bundle cannot be
  // published in place of a fresh one.
  rmSync(entryPath, { force: true });
  rmSync(bundlePath, { force: true });
}
