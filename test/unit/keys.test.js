import { describe, expect, it } from 'vitest';
import { HDNodeWallet, Mnemonic, wordlists } from 'ethers';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist as zhTW } from '@scure/bip39/wordlists/traditional-chinese';
import {
  DEFAULT_PATH,
  classifyInput,
  deriveFromMnemonic,
  inspectMnemonic,
  normalizeMnemonic,
  normalizePath,
  parseAddress,
  parsePrivateKey,
} from '../../src/core/keys.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const JUNK = 'test test test test test test test test test test test junk';
const ethersAddress = (phrase, passphrase = '', path = DEFAULT_PATH, wl) =>
  HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase, passphrase, wl), path).address;

describe('mnemonic derivation (BIP39 + BIP32/44)', () => {
  it('derives the well-known addresses', () => {
    expect(deriveFromMnemonic(ABANDON).address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(deriveFromMnemonic(JUNK).address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(deriveFromMnemonic(JUNK, '', "m/44'/60'/0'/0/1").address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });

  it('matches ethers with a passphrase and other paths', () => {
    for (const [pass, path] of [['TREZOR', DEFAULT_PATH], ['', "m/44'/60'/3'/0/0"], ['密語 ｐａｓｓ', "m/44'/60'/0'/7"]]) {
      expect(deriveFromMnemonic(ABANDON, pass, path).address).toBe(ethersAddress(ABANDON, pass, path));
    }
  });

  it('is case- and whitespace-insensitive for English', () => {
    const messy = '  Abandon ABANDON\tabandon abandon\nabandon abandon abandon abandon abandon abandon abandon   about ';
    expect(inspectMnemonic(messy)).toMatchObject({ status: 'ok', wordlist: 'english', wordCount: 12 });
    expect(deriveFromMnemonic(messy).address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  });

  it('handles Traditional Chinese mnemonics with or without spaces', () => {
    const phrase = entropyToMnemonic(new Uint8Array(16).fill(7), zhTW);
    const expected = ethersAddress(phrase, '', DEFAULT_PATH, wordlists.zh_tw);
    for (const variant of [phrase, phrase.replace(/ /g, ''), phrase.replace(/ /g, '　'), phrase.replace(/ /g, '  ')]) {
      expect(inspectMnemonic(variant)).toMatchObject({ status: 'ok', wordlist: 'traditionalChinese' });
      expect(deriveFromMnemonic(variant).address).toBe(expected);
    }
  });

  it('still derives unbundled wordlists (Japanese) correctly, flagged as unknown words', () => {
    const m = Mnemonic.fromEntropy(new Uint8Array(16).fill(3), '', wordlists.ja);
    expect(inspectMnemonic(m.phrase).status).toBe('unknownWords');
    expect(deriveFromMnemonic(m.phrase).address).toBe(HDNodeWallet.fromMnemonic(m, DEFAULT_PATH).address);
  });

  it('reports checksum errors, unknown words and bad lengths', () => {
    const swapped = ABANDON.replace('abandon abandon', 'about abandon');
    expect(inspectMnemonic(swapped)).toMatchObject({ status: 'badChecksum', wordlist: 'english' });
    expect(inspectMnemonic(ABANDON.replace('about', 'abuot'))).toMatchObject({ status: 'unknownWords', unknownWords: ['abuot'] });
    expect(inspectMnemonic('abandon about').status).toBe('badLength');
    expect(normalizeMnemonic('的一是在　不了')).toBe('的 一 是 在 不 了');
  });
});

describe('derivation path', () => {
  it('normalizes hardened markers', () => {
    expect(normalizePath("m/44h/60H/0'/0/0")).toBe(DEFAULT_PATH);
    expect(normalizePath('m/44’/60’/0’/0/5')).toBe("m/44'/60'/0'/0/5");
    expect(normalizePath("M/44'/60'/0'")).toBe("m/44'/60'/0'");
  });
  it('rejects malformed paths', () => {
    for (const p of ['', 'm', "44'/60'", "m/44'/x", "m//0", `m/${2 ** 31}`]) {
      expect(() => normalizePath(p), p).toThrowError('err.path');
    }
  });
});

describe('private keys and addresses', () => {
  const PK = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  it('parses keys with or without 0x', () => {
    const a = parsePrivateKey(PK);
    expect(a.address).toBe('0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
    expect(parsePrivateKey(PK.slice(2).toUpperCase())).toEqual(a);
  });
  it('rejects out-of-range keys', () => {
    expect(() => parsePrivateKey('0x' + '0'.repeat(64))).toThrowError('err.privateKey');
    expect(() => parsePrivateKey('0x' + 'f'.repeat(64))).toThrowError('err.privateKey');
    expect(() => parsePrivateKey('0x1234')).toThrowError('err.privateKey');
  });
  it('checks EIP-55 checksums', () => {
    const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(parseAddress(good)).toMatchObject({ address: good, checksum: 'valid' });
    expect(parseAddress(good.toLowerCase())).toMatchObject({ address: good, checksum: 'none' });
    expect(parseAddress('0X' + good.slice(2).toUpperCase())).toMatchObject({ address: good, checksum: 'none' });
    expect(parseAddress(good.replace('aAeb', 'aaEb'))).toMatchObject({ checksum: 'invalid' });
    expect(parseAddress(' 5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed ')).toMatchObject({ address: good });
    expect(parseAddress(`ethereum:${good}@137`)).toMatchObject({ address: good, chainId: 137 });
    expect(parseAddress('0x1234')).toBeNull();
  });
  it('classifies pasted input', () => {
    expect(classifyInput('')).toBe('empty');
    expect(classifyInput(PK)).toBe('privateKey');
    expect(classifyInput('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe('address');
    expect(classifyInput('{"version":3}')).toBe('keystore');
    expect(classifyInput(ABANDON)).toBe('mnemonic');
  });
});
