import { describe, it, expect } from 'vitest';
import { parseSourceHosts, selectOrphans } from './host-reaper.js';

describe('parseSourceHosts', () => {
  it('extracts pid + port from horus-source host lines (path-prefixed and --port=)', () => {
    const ps = [
      '  60530 /Users/x/.local/share/uv/tools/horus-source/bin/python3 /Users/x/.local/bin/horus-source host --port 8420',
      '81064 /usr/bin/python3 horus-source host --port=8421',
    ].join('\n');
    expect(parseSourceHosts(ps)).toEqual([
      { pid: 60530, port: 8420 },
      { pid: 81064, port: 8421 },
    ]);
  });

  it('ignores unrelated processes and blank lines', () => {
    const ps = [
      '12345 /usr/bin/node some-other-app --port 9999',
      '999 grep horus-source',
      '',
      '  ',
      '777 /bin/horus-source serve --foo', // not "host --port"
    ].join('\n');
    expect(parseSourceHosts(ps)).toEqual([]);
  });

  it('captures the full port number (no 8420-in-84200 false match)', () => {
    expect(parseSourceHosts('5 horus-source host --port 84200')).toEqual([{ pid: 5, port: 84200 }]);
  });
});

describe('selectOrphans', () => {
  const running = [
    { pid: 1, port: 8420 },
    { pid: 2, port: 8420 }, // duplicate on a claimed port — still an orphan by pid
    { pid: 3, port: 8421 },
  ];

  it('flags hosts whose pid is not claimed by any registered repo', () => {
    expect(selectOrphans(running, new Set([1, 3]))).toEqual([{ pid: 2, port: 8420 }]);
  });

  it('treats everything as orphan when nothing is claimed', () => {
    expect(selectOrphans(running, new Set())).toEqual(running);
  });

  it('returns none when every pid is claimed', () => {
    expect(selectOrphans(running, new Set([1, 2, 3]))).toEqual([]);
  });
});
