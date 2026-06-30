import { describe, it, expect } from 'vitest';
import { encodeNodePath } from './client.js';

describe('encodeNodePath (HOR-445)', () => {
  it('escapes # so a #private-method seed id does not truncate the URL at the fragment', () => {
    const id = 'method:source/core/Ky.ts:Ky.#consumeReturnedResponseFromBeforeRetryHook';
    const out = encodeNodePath(id);
    expect(out).not.toContain('#'); // the bug: encodeURI left this literal → fragment → 404
    expect(out).toContain('%23');
    // path-shaped delimiters stay literal so the backend route still matches the node id
    expect(out).toContain('/core/Ky.ts');
    expect(out).toContain(':');
  });

  it('escapes a literal ? too (would otherwise start the query string)', () => {
    expect(encodeNodePath('a?b')).toBe('a%3Fb');
  });

  it('leaves an ordinary path-shaped node id (/ and :) intact', () => {
    expect(encodeNodePath('method:source/foo.ts:Bar.baz')).toBe('method:source/foo.ts:Bar.baz');
  });
});
