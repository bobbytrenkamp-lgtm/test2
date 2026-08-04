import { closeDatabase, getDatabase } from '../client.js';
import { migrate } from '../migrate.js';

const sql = getDatabase();
try {
  const result = await migrate(sql);
  if (result.applied.length === 0) {
    console.warn(`No new migrations. ${result.skipped.length} already applied.`);
  } else {
    console.warn(`Applied ${result.applied.length} migration(s):`);
    for (const name of result.applied) console.warn(`  - ${name}`);
  }
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
