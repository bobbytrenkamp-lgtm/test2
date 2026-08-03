import { closeDatabase, getDatabase } from '../client.js';
import { seedDemonstrationData } from '../seed.js';

const sql = getDatabase();
try {
  const result = await seedDemonstrationData(sql);
  console.warn('Demonstration data created. All of it is fictional.');
  console.warn(`  Organization: ${result.organizationId}`);
  console.warn(`  Properties:   ${Object.keys(result.propertyIds).join(', ')}`);
  console.warn('  Sign in with:');
  for (const user of result.users) {
    console.warn(`    ${user.email} / ${user.password}  (${user.role})`);
  }
} catch (error) {
  console.error('Seeding failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
