import { run } from '@horus/cli';

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
