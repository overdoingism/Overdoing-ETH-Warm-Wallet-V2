import { describe, expect, it } from 'vitest';
import { Wallet, encryptKeystoreJson } from 'ethers';
import { decryptKeystore, encryptKeystore, keystoreFileName, parseKeystore } from '../../src/core/keystore.js';
import { createVault } from '../../src/core/vault.js';

// Test vectors from the Web3 Secret Storage definition (password "testpassword").
const VECTOR_PK = '0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d';
const PBKDF2_VECTOR = {
  crypto: {
    cipher: 'aes-128-ctr',
    cipherparams: { iv: '6087dab2f9fdbbfaddc31a909735c1e6' },
    ciphertext: '5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46',
    kdf: 'pbkdf2',
    kdfparams: { c: 262144, dklen: 32, prf: 'hmac-sha256', salt: 'ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd' },
    mac: '517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2',
  },
  id: '3198bc9c-6672-5ab3-d995-4942343ae5b6',
  version: 3,
};
const SCRYPT_VECTOR = {
  crypto: {
    cipher: 'aes-128-ctr',
    cipherparams: { iv: '83dbcc02d8ccb40e466191a123791e0e' },
    ciphertext: 'd172bf743a674da9cdad04534d56926ef8358534d458fffccd4e6ad2fbde479c',
    kdf: 'scrypt',
    kdfparams: { dklen: 32, n: 262144, r: 1, p: 8, salt: 'ab0c7876052600dd703518d6fc3fe8984592145b591fc8fb5c6d43190334ba19' },
    mac: '2103ac29920d71da29f15d75b4a16dbe95cfd7ff8faea1056c33131d846e3097',
  },
  id: '3198bc9c-6672-5ab3-d995-4942343ae5b6',
  version: 3,
};
const PK = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const FAST = { n: 1 << 10 };

describe('keystore V3', () => {
  it('decrypts the spec vectors (pbkdf2 and scrypt)', async () => {
    expect((await decryptKeystore(PBKDF2_VECTOR, 'testpassword')).privateKey).toBe(VECTOR_PK);
    expect((await decryptKeystore(JSON.stringify(SCRYPT_VECTOR), 'testpassword')).privateKey).toBe(VECTOR_PK);
  }, 60_000);

  it('round-trips and rejects a wrong password', async () => {
    const ks = await encryptKeystore(PK, 'correct horse', FAST);
    expect(ks.address).toBe('2c7536e3605d9c16a7a3d7b1898e529396a65c23');
    expect(ks.crypto.kdfparams.n).toBe(1024);
    expect(await decryptKeystore(ks, 'correct horse')).toEqual({ privateKey: PK, address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23' });
    await expect(decryptKeystore(ks, 'wrong')).rejects.toThrowError('err.ksPassword');
  });

  it('is compatible with ethers in both directions', async () => {
    const ours = await encryptKeystore(PK, 'pw', FAST);
    expect((await Wallet.fromEncryptedJson(JSON.stringify(ours), 'pw')).privateKey).toBe(PK);
    const theirs = await encryptKeystoreJson({ address: new Wallet(PK).address, privateKey: PK }, 'pw', { scrypt: { N: 1 << 10 } });
    expect((await decryptKeystore(theirs, 'pw')).privateKey).toBe(PK);
  });

  it('accepts full-width passwords from both raw-UTF-8 and NFKC implementations', async () => {
    const pw = 'ｐａｓｓ密碼';
    expect((await decryptKeystore(await encryptKeystore(PK, pw, FAST), pw)).privateKey).toBe(PK);
    const ethersJson = await encryptKeystoreJson({ address: new Wallet(PK).address, privateKey: PK }, pw, { scrypt: { N: 1 << 10 } });
    expect((await decryptKeystore(ethersJson, pw)).privateKey).toBe(PK);
  });

  it('rejects malformed or hostile parameters before running the KDF', () => {
    const bad = (patch) => ({ ...SCRYPT_VECTOR, crypto: { ...SCRYPT_VECTOR.crypto, ...patch } });
    expect(() => parseKeystore('not json')).toThrowError('err.ksFormat');
    expect(() => parseKeystore({ version: 3 })).toThrowError('err.ksFormat');
    expect(() => parseKeystore(bad({ kdfparams: { ...SCRYPT_VECTOR.crypto.kdfparams, n: 1 << 24 } }))).toThrowError('err.ksUnsupported');
    expect(() => parseKeystore(bad({ kdfparams: { ...SCRYPT_VECTOR.crypto.kdfparams, n: 1000 } }))).toThrowError('err.ksUnsupported');
    expect(() => parseKeystore(bad({ cipher: 'aes-128-cbc' }))).toThrowError('err.ksUnsupported');
    expect(() => parseKeystore(bad({ ciphertext: 'zz' }))).toThrowError('err.ksFormat');
  });

  it('detects an address that does not match the key', async () => {
    const ks = await encryptKeystore(PK, 'pw', FAST);
    ks.address = '0000000000000000000000000000000000000001';
    await expect(decryptKeystore(ks, 'pw')).rejects.toThrowError('err.ksAddressMismatch');
  });

  it('names files like geth', () => {
    expect(keystoreFileName('0xAbCd000000000000000000000000000000000000', new Date('2026-01-02T03:04:05.000Z'))).toBe(
      'UTC--2026-01-02T03-04-05.000Z--abcd000000000000000000000000000000000000.json',
    );
  });
});

describe('browser vault', () => {
  const memoryStorage = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), dump: () => m };
  };

  it('stores encrypted entries only', async () => {
    const storage = memoryStorage();
    const vault = createVault(storage);
    const e = await vault.add('  Main  ', PK, 'pw', FAST);
    expect(vault.list()).toEqual([{ id: e.id, name: 'Main', address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', created: e.created }]);
    expect([...storage.dump().values()].join('')).not.toContain(PK.slice(2));
    expect((await vault.unlock(e.id, 'pw')).privateKey).toBe(PK);
    await expect(vault.unlock(e.id, 'nope')).rejects.toThrowError('err.ksPassword');
    vault.remove(e.id);
    expect(vault.list()).toEqual([]);
  });

  it('survives corrupt data and reports unavailable storage', async () => {
    const storage = memoryStorage();
    storage.setItem('oeww.vault.v1', '{broken');
    expect(createVault(storage).list()).toEqual([]);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => createVault(broken).list()).toThrowError('err.storage');
  });
});
