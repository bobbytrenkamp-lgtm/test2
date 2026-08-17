import { chromium } from 'playwright-core';

/**
 * Server-side PDF rendering.
 *
 * The report route's own print-HTML has always worked through the browser's
 * print-to-PDF dialog; this is the "true server-side rendering" that
 * `docs/reporting-specification.md` named as needing a headless browser in
 * the worker image rather than being faked with a placeholder. It runs here
 * (a job handler), not in the API request path, for the same reason
 * scenario batches and workbook exports do: launching a browser process
 * takes real wall-clock time this codebase already queues rather than
 * blocking a request on.
 *
 * `CHROMIUM_EXECUTABLE_PATH`, when set, points at a system Chromium — the
 * production image installs one via Alpine's own `chromium` package rather
 * than downloading Playwright's, because Playwright's own browser download
 * targets glibc and this image is musl-based. Unset (every local checkout
 * and this repository's own CI), `chromium.launch()` resolves whichever
 * browser `playwright-core` itself already manages, which is exactly the
 * one `pnpm exec playwright install chromium` puts in place for the
 * end-to-end suite.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    });
  } catch (error) {
    throw new Error(
      'No Chromium build is available to render a PDF. Run `pnpm exec playwright install chromium`, ' +
        'or set CHROMIUM_EXECUTABLE_PATH to a system Chromium binary.',
      { cause: error },
    );
  }

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
    });
  } finally {
    await browser.close();
  }
}
