import { expect, test, type Page } from '@playwright/test';
import { SEED, sessionFile } from './roles.js';

/**
 * The accessibility tree, audited.
 *
 * **This is not the screen-reader audit.** `docs/feature-status.md` reserves
 * "Production ready" for features that have been used with real assistive
 * technology, and nothing automated can stand in for a person driving JAWS or
 * VoiceOver through a valuation. That audit is still outstanding and this file
 * does not close it.
 *
 * What it does close is the part a machine *can* check and `axe-core` does not.
 * axe applies rules to the DOM; this reads the accessibility tree — the thing a
 * screen reader actually consumes — and holds it to properties that make a page
 * navigable rather than merely conformant:
 *
 * - **Headings form a ladder.** Jumping from `h1` to `h3` is valid HTML and
 *   passes axe. To somebody navigating by heading it reads as a missing
 *   section, and they go looking for content that was never there.
 * - **Controls are distinguishable from one another.** axe checks that a button
 *   has a name; it does not check that nine buttons on the same screen have
 *   *different* ones. A rotor listing "View, View, View, View…" is the single
 *   most common way a page passes every automated check and is still unusable.
 * - **Tables are named.** A screen reader announces a table by its accessible
 *   name. Three unnamed tables on a screen are three identical announcements.
 * - **The page has landmarks**, so there is a way to skip to the content
 *   without walking the navigation on every screen.
 *
 * Every failure here names the screen and the offending text, because a
 * violation nobody can locate is a violation nobody fixes.
 */

/** Screens worth auditing, and how to reach each. */
const SCREENS: Array<{ name: string; open: (page: Page) => Promise<void> }> = [
  {
    name: 'Dashboard',
    open: async (page) => {
      await page.goto('/');
      await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    },
  },
  {
    name: 'Properties',
    open: async (page) => {
      await page.goto('/properties');
      await expect(page.getByRole('heading', { name: 'Properties', level: 1 })).toBeVisible();
    },
  },
  {
    name: 'Tasks',
    open: async (page) => {
      await page.goto('/tasks');
      await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
    },
  },
  {
    name: 'Security',
    open: async (page) => {
      await page.goto('/security');
      await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
    },
  },
  {
    name: 'Portfolios',
    open: async (page) => {
      await page.goto('/portfolios');
      await expect(page.getByRole('heading', { name: 'Portfolios', level: 1 })).toBeVisible();
    },
  },
  {
    name: 'Funds',
    open: async (page) => {
      await page.goto('/funds');
      await expect(page.getByRole('heading', { name: 'Funds', level: 1 })).toBeVisible();
    },
  },
  {
    name: 'Organization',
    open: async (page) => {
      await page.goto('/organization');
      await expect(page.getByRole('heading', { name: 'Organization', level: 1 })).toBeVisible();
    },
  },
  {
    name: 'Background jobs',
    open: async (page) => {
      await page.goto('/jobs');
      await expect(page.getByRole('heading', { name: 'Background jobs', level: 1 })).toBeVisible();
    },
  },
  {
    name: 'Audit history',
    open: async (page) => {
      await page.goto('/audit');
      await expect(page.getByRole('heading', { name: 'Audit history', level: 1 })).toBeVisible();
    },
  },
  {
    name: 'Rent roll',
    open: async (page) => {
      await page.goto('/properties');
      await page.getByRole('link', { name: SEED.office.property }).click();
      await page.getByRole('link', { name: SEED.office.model }).click();
      await page.getByRole('link', { name: 'Rent roll' }).click();
      await expect(page.getByRole('heading', { name: 'Leases' })).toBeVisible();
    },
  },
  {
    name: 'Cash flow',
    open: async (page) => {
      await page.goto('/properties');
      await page.getByRole('link', { name: SEED.office.property }).click();
      await page.getByRole('link', { name: SEED.office.model }).click();
      const finished = page.waitForResponse(
        (r) => r.url().includes('/calculate') && r.request().method() === 'POST',
        { timeout: 120_000 },
      );
      await page.getByRole('button', { name: /^Calculat/ }).click();
      await finished;
      await expect(page.getByRole('table', { name: /cash flow/i })).toBeVisible();
    },
  },
  {
    name: 'Reports',
    open: async (page) => {
      await page.goto('/properties');
      await page.getByRole('link', { name: SEED.office.property }).click();
      await page.getByRole('link', { name: SEED.office.model }).click();
      await page.getByRole('link', { name: 'Reports' }).click();
      await expect(page.getByRole('heading', { name: 'Reports', level: 2 })).toBeVisible();
    },
  },
];

test.use({ storageState: sessionFile('owner') });

/** Heading levels in document order, as a screen reader would walk them. */
async function headingLevels(page: Page): Promise<Array<{ level: number; text: string }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map((node) => ({
        level: Number(node.tagName[1]),
        text: (node.textContent ?? '').trim().slice(0, 60),
      })),
  );
}

for (const screen of SCREENS) {
  test(`${screen.name}: headings form a ladder with no skipped level`, async ({ page }) => {
    await screen.open(page);
    const headings = await headingLevels(page);
    expect(
      headings.length,
      'a screen with no headings cannot be navigated by heading',
    ).toBeGreaterThan(0);

    const skips: string[] = [];
    let previous = 0;
    for (const heading of headings) {
      // Going deeper by more than one level is the failure. Coming back out by
      // any amount is normal — a new section at a higher level.
      if (previous !== 0 && heading.level > previous + 1) {
        skips.push(`h${previous} → h${heading.level} at "${heading.text}"`);
      }
      previous = heading.level;
    }
    expect(skips, `${screen.name} skips heading levels:\n${skips.join('\n')}`).toEqual([]);
  });

  test(`${screen.name}: every table is announced by name`, async ({ page }) => {
    await screen.open(page);
    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table'))
        .filter((table) => {
          const caption = table.querySelector('caption')?.textContent?.trim();
          const label = table.getAttribute('aria-label')?.trim();
          const describedBy = table.getAttribute('aria-labelledby')?.trim();
          return !caption && !label && !describedBy;
        })
        .map((table) => (table.textContent ?? '').trim().slice(0, 60)),
    );
    expect(
      unnamed,
      `${screen.name} has ${unnamed.length} table(s) a screen reader announces as just "table".`,
    ).toEqual([]);
  });

  test(`${screen.name}: controls are distinguishable from one another`, async ({ page }) => {
    await screen.open(page);
    /*
     * The rotor test. A screen reader user pulls up a list of every button on
     * the page; if six of them say "View" the list is useless, and no automated
     * rule catches it because each button is individually named.
     *
     * Controls inside a table row that has a row header are exempt: a screen
     * reader announces the row's header alongside the cell, so "View" in the
     * row headed "Rent roll summary" is not ambiguous when navigating the
     * table. It is still ambiguous in a flat rotor list — the honest position
     * is that this check catches the unambiguous cases and a human is needed
     * for the rest, which is why the audit below is not the whole audit.
     */
    const duplicates = await page.evaluate(() => {
      const named = new Map<string, number>();
      for (const control of Array.from(
        document.querySelectorAll('button, a[href], select, [role="button"]'),
      )) {
        if (control.closest('tr')?.querySelector('th[scope="row"]')) continue;
        const style = getComputedStyle(control);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const name = (control.getAttribute('aria-label') ?? control.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!name) continue;
        named.set(name, (named.get(name) ?? 0) + 1);
      }
      return Array.from(named.entries())
        .filter(([, count]) => count > 1)
        .map(([name, count]) => `${count} controls all named "${name}"`);
    });

    expect(
      duplicates,
      `${screen.name} has controls a rotor cannot tell apart:\n${duplicates.join('\n')}`,
    ).toEqual([]);
  });

  test(`${screen.name}: the page offers landmarks to skip into`, async ({ page }) => {
    await screen.open(page);
    // Without a main landmark there is no way past the navigation except to
    // walk it, on every screen, every time.
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(1);
  });
}

test('the accessibility tree of the cash-flow grid names its own dimensions', async ({ page }) => {
  const screen = SCREENS.find((entry) => entry.name === 'Cash flow');
  await screen?.open(page);

  /*
   * The grid virtualises its columns, so the DOM holds a fraction of them. A
   * screen reader is told the true width by `aria-colcount`, and each cell its
   * true position by `aria-colindex` — without those, the forecast announces as
   * a fraction of its length and a user has no idea what they are missing.
   */
  const table = page.locator('table.freeze-first');
  const colcount = Number(await table.getAttribute('aria-colcount'));
  expect(colcount).toBeGreaterThan(1);

  const indices = await table.evaluate((node) =>
    Array.from(node.querySelectorAll('thead th[aria-colindex]')).map((cell) =>
      Number(cell.getAttribute('aria-colindex')),
    ),
  );
  expect(indices.length).toBeGreaterThan(0);
  // Every announced position is inside the announced width.
  for (const index of indices) {
    expect(index).toBeGreaterThanOrEqual(1);
    expect(index).toBeLessThanOrEqual(colcount);
  }
});
