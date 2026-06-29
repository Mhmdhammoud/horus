import { run, reportCrash } from '@horus/cli';

run().catch((err: unknown) => {
  // HOR-439: surface the `horus report` bug/gap path on an unexpected crash.
  reportCrash(err);
  process.exit(1);
});
