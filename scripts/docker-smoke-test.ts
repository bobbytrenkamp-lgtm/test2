/**
 * Docker smoke test.
 *
 * The container images have a long history of being reviewed but never
 * actually run (see docs/deployment-guide.md). This drives the real,
 * built images over HTTP — not the source in-process the way the test
 * suite does — to prove the specific things a review cannot: that the API
 * container starts and reaches the database, that the web container serves
 * the built bundle, and that the worker container's Alpine-packaged
 * Chromium (apk add chromium, not Playwright's own managed browser) can
 * actually render a PDF end to end, which nothing else in this repository
 * has ever exercised.
 *
 *   pnpm docker:smoke-test
 *
 * Expects `docker compose -f infrastructure/docker-compose.yml up -d
 * postgres api worker web` to already be running (the CI job that calls
 * this brings the stack up itself); this script only talks to it.
 */
const API_URL = process.env.SMOKE_API_URL ?? 'http://localhost:4000';
const WEB_URL = process.env.SMOKE_WEB_URL ?? 'http://localhost:8080';
const HEADERS = { 'x-requested-with': 'cre-platform', 'content-type': 'application/json' };

function extractCookie(raw: string | null): string {
  const session = raw
    ?.split(/,(?=[^;]+=[^;]+)/)
    .map((part) => part.trim())
    .find((part) => part.startsWith('cre_session='));
  if (!session) throw new Error(`No session cookie in Set-Cookie: ${raw ?? '(none)'}`);
  return session.split(';')[0] as string;
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`${label}... `);
  try {
    const result = await run();
    console.warn('ok');
    return result;
  } catch (error) {
    console.warn('FAILED');
    throw error;
  }
}

async function main(): Promise<void> {
  // The API container migrates the database before it starts serving, so it
  // is not necessarily up the moment its container is — this is the one step
  // that waits rather than checking once, for that reason.
  await step('API reports healthy', async () => {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${API_URL}/api/v1/health`);
        const body = (await response.json()) as { status: string };
        if (response.ok && body.status === 'ok') return;
        lastError = new Error(
          `Unexpected health response: ${response.status} ${JSON.stringify(body)}`,
        );
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `API never became healthy: ${lastError instanceof Error ? lastError.message : lastError}`,
    );
  });

  await step('Web container serves the built bundle', async () => {
    const deadline = Date.now() + 20_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(WEB_URL);
        const body = await response.text();
        if (response.ok && body.includes('id="root"') && body.includes('CRE Platform')) return;
        lastError = new Error(`Unexpected response from web container: ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Web container never came up: ${lastError instanceof Error ? lastError.message : lastError}`,
    );
  });

  const suffix = Date.now();
  const cookie = await step('Register a user against the containerized API', async () => {
    const response = await fetch(`${API_URL}/api/v1/auth/register`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        email: `docker-smoke-${suffix}@example.invalid`,
        name: 'Docker Smoke Test',
        password: 'a-sufficiently-long-password',
      }),
    });
    if (response.status !== 201) {
      throw new Error(`Registration failed (${response.status}): ${await response.text()}`);
    }
    return extractCookie(response.headers.get('set-cookie'));
  });
  const authed = { ...HEADERS, cookie };

  await step('Create an organization', async () => {
    const response = await fetch(`${API_URL}/api/v1/organizations`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ name: 'Docker Smoke Test Partners' }),
    });
    if (response.status !== 201) {
      throw new Error(
        `Organization creation failed (${response.status}): ${await response.text()}`,
      );
    }
  });

  const propertyId = await step('Create a property and a space', async () => {
    const property = await fetch(`${API_URL}/api/v1/properties`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({
        name: 'Smoke Test Tower',
        propertyType: 'office',
        rentableArea: '12000',
      }),
    });
    const { property: created } = (await property.json()) as { property: { id: string } };
    await fetch(`${API_URL}/api/v1/properties/${created.id}/spaces`, {
      method: 'PUT',
      headers: authed,
      body: JSON.stringify({ spaces: [{ code: 'WHOLE', spaceType: 'office', area: '12000' }] }),
    });
    return created.id;
  });

  const tenantId = await step('Create a tenant', async () => {
    const response = await fetch(`${API_URL}/api/v1/tenants`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ name: 'Smoke Test Anchor Tenant' }),
    });
    const { tenant } = (await response.json()) as { tenant: { id: string } };
    return tenant.id;
  });

  const modelId = await step('Create a model and a lease, then calculate', async () => {
    const model = await fetch(`${API_URL}/api/v1/models`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({
        propertyId,
        name: 'Smoke test base case',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 24,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      }),
    });
    const { model: created } = (await model.json()) as { model: { id: string } };

    await fetch(`${API_URL}/api/v1/models/${created.id}/leases/L-1`, {
      method: 'PUT',
      headers: authed,
      body: JSON.stringify({
        tenantId,
        status: 'occupied',
        area: '12000',
        spaceIds: ['WHOLE'],
        commencementDate: '2026-01-01',
        expirationDate: '2032-12-31',
        baseRent: '29.00',
        baseRentBasis: 'per_area_per_year',
      }),
    });

    const calculated = await fetch(`${API_URL}/api/v1/models/${created.id}/calculate`, {
      method: 'POST',
      headers: authed,
    });
    if (calculated.status !== 200) {
      throw new Error(`Calculate failed (${calculated.status}): ${await calculated.text()}`);
    }
    return created.id;
  });

  const jobId = await step('Enqueue server-side PDF rendering', async () => {
    const response = await fetch(`${API_URL}/api/v1/models/${modelId}/reports/rent-roll/pdf`, {
      method: 'POST',
      headers: authed,
    });
    if (response.status !== 200) {
      throw new Error(`PDF enqueue failed (${response.status}): ${await response.text()}`);
    }
    const { jobId: id, status } = (await response.json()) as { jobId: string; status: string };
    if (status !== 'queued') throw new Error(`Expected status "queued", got "${status}"`);
    return id;
  });

  await step('Worker container renders real PDF bytes with Alpine-packaged Chromium', async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${API_URL}/api/v1/jobs/${jobId}`, { headers: authed });
      const { job } = (await response.json()) as {
        job: {
          status: string;
          error_message: string | null;
          result: { encoding: string; content: string; filename: string } | null;
        };
      };
      if (job.status === 'failed') {
        throw new Error(`Job failed: ${job.error_message ?? '(no message)'}`);
      }
      if (job.status === 'succeeded') {
        if (job.result?.encoding !== 'base64' || job.result.filename !== 'rent-roll.pdf') {
          throw new Error(`Unexpected job result: ${JSON.stringify(job.result)}`);
        }
        const pdf = Buffer.from(job.result.content, 'base64');
        if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
          throw new Error('Result does not start with the PDF magic bytes.');
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Timed out waiting for the worker to pick up and complete the render job.');
  });

  console.warn('\nDocker smoke test passed: images built, containers run, a real PDF came back.');
}

main().catch((error: unknown) => {
  console.error(`\nDocker smoke test failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
