import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJsonc, prefixAlias } from '../src/resolver-options.ts';

describe('prefixAlias', () => {
  it('turns a prefix mapping into a resolver alias', () => {
    assert.deepEqual(prefixAlias('^@app/(.*)$', ['/repo/src/$1']), { key: '@app', targets: ['/repo/src'] });
  });

  it('turns an exact mapping into an exact alias', () => {
    assert.deepEqual(prefixAlias('^lodash$', ['lodash-es']), { key: 'lodash$', targets: ['lodash-es'] });
    assert.deepEqual(prefixAlias('^@nx\\/devkit$', ['/repo/packages/devkit/index.ts']), { key: '@nx/devkit$', targets: ['/repo/packages/devkit/index.ts'] });
  });

  it('leaves real regular expressions alone', () => {
    assert.equal(prefixAlias('\\.(css|less)$', ['identity-obj-proxy']), undefined);
    assert.equal(prefixAlias('^@app/(.*)/index$', ['/src/$1']), undefined);
  });
});

describe('parseJsonc', () => {
  it('accepts comments and trailing commas', () => {
    assert.deepEqual(parseJsonc('{\n // note\n "a": "http://x", /* b */ "c": [1,],\n}'), { a: 'http://x', c: [1] });
  });
});
