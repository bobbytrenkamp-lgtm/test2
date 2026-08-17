import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { loadEnv } from './env.js';
import { LocalStorage, createStorage } from './storage.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-to-pass',
  SESSION_COOKIE_SECURE: 'false',
};

describe('createStorage', () => {
  it('defaults to LocalStorage, rooted at STORAGE_LOCAL_DIR', () => {
    const env = loadEnv(BASE_ENV);
    expect(env.STORAGE_DRIVER).toBe('local');
    expect(createStorage(env)).toBeInstanceOf(LocalStorage);
  });

  it('refuses to start with STORAGE_DRIVER=s3, which nothing implements yet', () => {
    // Named as an interface, the same way MAIL_DRIVER=smtp is — but unlike
    // smtp, no implementation exists, so this refuses at startup rather
    // than accepting the setting and failing the first upload instead.
    expect(() => loadEnv({ ...BASE_ENV, STORAGE_DRIVER: 's3' })).toThrow(
      /STORAGE_DRIVER=s3 has no implementation/,
    );
  });
});

describe('LocalStorage', () => {
  let root: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cre-storage-test-'));
    storage = new LocalStorage(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('round-trips real bytes, and reports the size and checksum it actually wrote', async () => {
    const bytes = Buffer.from('Lease abstract for suite 400.');
    const stored = await storage.save('org-1', bytes);

    expect(stored.byteSize).toBe(bytes.byteLength);
    expect(stored.checksumSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(stored.storageKey.startsWith('org-1/')).toBe(true);

    const read = await storage.read(stored.storageKey);
    expect(read.equals(bytes)).toBe(true);
  });

  it('removes what it wrote', async () => {
    const stored = await storage.save('org-1', Buffer.from('gone soon'));
    await storage.remove(stored.storageKey);
    await expect(storage.read(stored.storageKey)).rejects.toThrow();
  });

  it('gives two saves of the same bytes two different keys', async () => {
    const bytes = Buffer.from('same content, different upload');
    const first = await storage.save('org-1', bytes);
    const second = await storage.save('org-1', bytes);
    expect(first.storageKey).not.toBe(second.storageKey);
  });

  it('refuses to resolve a storage key that tries to escape the storage root', async () => {
    // A key this module hands out itself never looks like this — this is the
    // defense for a key read back out of the database being an external
    // input all the same, the same reasoning `resolvePath`'s own comment
    // gives.
    await expect(storage.read('../../etc/passwd')).rejects.toThrow(/outside the storage root/);
  });
});
