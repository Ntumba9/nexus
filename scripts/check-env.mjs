// Reports which environment variables are set, grouped by how much NEXUS needs them.
// Prints variable NAMES and set/missing status only — never values.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  loadDotEnv,
  loadEnv,
  apiEnvSchema,
  workerEnvSchema,
  webEnvSchema,
} = require('../packages/config/dist');

const loaded = loadDotEnv();
console.log(
  loaded
    ? 'Loaded a .env file (values are never printed).'
    : 'No .env file found — using the shell environment only.',
);

const groups = {
  'Required now (NEXUS cannot start without these)': ['DATABASE_URL', 'REDIS_URL'],
  'Required for docker compose': ['POSTGRES_PASSWORD'],
  'Optional now (defaults exist)': [
    'NODE_ENV',
    'LOG_LEVEL',
    'API_HOST',
    'API_PORT',
    'WEB_ORIGIN',
    'SWAGGER_ENABLED',
    'API_INTERNAL_URL',
    'WORKER_CONCURRENCY',
    'WORKER_HEALTH_HOST',
    'WORKER_HEALTH_PORT',
    'POSTGRES_HOST_PORT',
    'REDIS_HOST_PORT',
  ],
  'Optional (the feature is off until it is set)': [
    'INTEGRATION_ENCRYPTION_KEY',
    'SMTP_URL',
    'EMAIL_FROM',
  ],
  'Required later (Phase 9 AI investigation; optional until then)': ['ANTHROPIC_API_KEY'],
};

let missingRequired = false;
for (const [title, names] of Object.entries(groups)) {
  console.log(`\n${title}`);
  for (const name of names) {
    const isSet = Boolean(process.env[name]?.trim());
    if (!isSet && title.startsWith('Required now')) missingRequired = true;
    console.log(`  ${isSet ? 'set    ' : 'missing'}  ${name}`);
  }
}

console.log('\nValidation against the real schemas:');
for (const [name, schema] of [
  ['api', apiEnvSchema],
  ['workers', workerEnvSchema],
  ['web', webEnvSchema],
]) {
  try {
    loadEnv(schema);
    console.log(`  ${name}: OK`);
  } catch (error) {
    missingRequired = true;
    console.log(`  ${name}: INVALID\n${String(error.message).split('\n').slice(1).join('\n')}`);
  }
}
process.exit(missingRequired ? 1 : 0);
