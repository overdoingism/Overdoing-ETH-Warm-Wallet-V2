import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DICT } from '../../src/i18n.js';

const src = (f) => readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf8');
const sources = ['main.js', 'core/keys.js', 'core/keystore.js', 'core/vault.js', 'core/tx.js', 'core/rpc.js', 'core/amount.js', 'core/chains.js', 'core/message.js'].map(src).join('\n');

describe('translations', () => {
  const zh = Object.keys(DICT['zh-TW']);
  const en = Object.keys(DICT.en);

  it('has the same keys in both languages', () => {
    expect(zh.filter((k) => !(k in DICT.en))).toEqual([]);
    expect(en.filter((k) => !(k in DICT['zh-TW']))).toEqual([]);
  });

  it('covers every key the HTML and the code refer to', () => {
    const html = src('index.html');
    // Any 'namespace.key' string literal in the code, whichever way it reaches t().
    const namespaces = new Set(zh.map((k) => k.split('.')[0]));
    const used = new Set([
      ...[...html.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map((m) => m[1]),
      ...[...sources.matchAll(/'([a-zA-Z0-9]+)\.([a-zA-Z0-9]+)'/g)].filter((m) => namespaces.has(m[1])).map((m) => `${m[1]}.${m[2]}`),
    ]);
    expect(used.size).toBeGreaterThan(250); // the scan itself works
    expect([...used].filter((k) => !(k in DICT['zh-TW']))).toEqual([]);
  });

  it('uses the same placeholders in both languages', () => {
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    expect(zh.filter((k) => vars(DICT['zh-TW'][k]) !== vars(DICT.en[k]))).toEqual([]);
  });
});
