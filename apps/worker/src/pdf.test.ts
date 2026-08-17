import { describe, expect, it } from 'vitest';
import { renderHtmlToPdf } from './pdf.js';

/**
 * Real PDF bytes out of a real headless browser, not a mock — the point of
 * this module existing at all is that `docs/reporting-specification.md`'s
 * "server-side PDF" was previously deferred rather than faked, and a test
 * that stubbed the browser away would reintroduce exactly that gap under a
 * passing test.
 */
describe('renderHtmlToPdf', () => {
  it('renders real PDF bytes from HTML', async () => {
    const html = `<!doctype html><html><head><title>Test report</title></head>
      <body><h1>A rendered report</h1><p>Renders through a real headless browser.</p></body></html>`;

    const pdf = await renderHtmlToPdf(html);

    expect(pdf.byteLength).toBeGreaterThan(0);
    // The PDF file-format magic bytes, not merely "some buffer came back".
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 30_000);
});
