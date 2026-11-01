// Run with `node --test extension/*.test.js` (part of `npm test`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAddress, sitePermission } from './address.js';

test('addresses are normalised', () => {
  assert.equal(normalizeAddress(' notes.example.com/ '), 'https://notes.example.com');
  assert.equal(normalizeAddress('https://example.com/nicotes/'), 'https://example.com/nicotes');
  assert.equal(normalizeAddress('http://192.168.1.20:3000'), 'http://192.168.1.20:3000');
  assert.equal(normalizeAddress('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeAddress('127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(normalizeAddress(''), null);
  assert.equal(normalizeAddress('ftp://example.com'), null);
  assert.equal(normalizeAddress('not an address'), null);
});

test('site access covers the host on any port', () => {
  assert.deepEqual(sitePermission('http://localhost:3000'), { origins: ['http://localhost/*'] });
  assert.deepEqual(sitePermission('https://example.com/nicotes'), { origins: ['https://example.com/*'] });
});
