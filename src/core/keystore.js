// Web3 Secret Storage (keystore V3): the format used by geth, MetaMask, MEW and ethers.
// The same format backs the browser vault, so "export" is just a download of an entry.
import { scryptAsync } from '@noble/hashes/scrypt';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { ctr } from '@noble/ciphers/aes';
import { bytesToHex, hexToBytes, getAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { WalletError } from './errors.js';

// 2^17 is ethers' default: ~128 MB of memory, which phones can still handle.
export const DEFAULT_SCRYPT_N = 1 << 17;
const MAX_SCRYPT_N = 1 << 20;
const MAX_PBKDF2_C = 10_000_000;

const hex = (bytes) => bytesToHex(bytes).slice(2);
const unhex = (s, field) => {
  if (typeof s !== 'string' || !/^(0x)?([0-9a-fA-F]{2})+$/.test(s)) throw new WalletError('err.ksFormat', { field });
  return hexToBytes(s.startsWith('0x') ? s : '0x' + s);
};

function uuidV4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const macOf = (dk, ciphertext) => keccak_256(concatBytes(dk.slice(16, 32), ciphertext));

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function encryptKeystore(privateKey, password, { n = DEFAULT_SCRYPT_N, onProgress } = {}) {
  if (!password) throw new WalletError('err.passwordEmpty');
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk = await scryptAsync(utf8ToBytes(password), salt, { N: n, r: 8, p: 1, dkLen: 32, onProgress });
  const ciphertext = ctr(dk.slice(0, 16), iv).encrypt(hexToBytes(privateKey));
  return {
    address: privateKeyToAddress(privateKey).slice(2).toLowerCase(),
    id: uuidV4(),
    version: 3,
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: hex(iv) },
      ciphertext: hex(ciphertext),
      kdf: 'scrypt',
      kdfparams: { dklen: 32, n, p: 1, r: 8, salt: hex(salt) },
      mac: hex(macOf(dk, ciphertext)),
    },
  };
}

/** Parses and sanity-checks keystore JSON without decrypting it. */
export function parseKeystore(json) {
  let ks = json;
  if (typeof json === 'string') {
    try {
      ks = JSON.parse(json);
    } catch {
      throw new WalletError('err.ksFormat');
    }
  }
  const c = ks?.crypto ?? ks?.Crypto;
  if (!ks || Number(ks.version) !== 3 || !c) throw new WalletError('err.ksFormat');
  if (String(c.cipher).toLowerCase() !== 'aes-128-ctr') throw new WalletError('err.ksUnsupported', { what: String(c.cipher) });
  const kp = c.kdfparams ?? {};
  const kdf = String(c.kdf).toLowerCase();
  if (kdf === 'scrypt') {
    const { n, r, p } = kp;
    if (!Number.isSafeInteger(n) || n < 2 || n > MAX_SCRYPT_N || (n & (n - 1)) !== 0) throw new WalletError('err.ksUnsupported', { what: `scrypt n=${n}` });
    if (!Number.isSafeInteger(r) || r < 1 || r > 32 || !Number.isSafeInteger(p) || p < 1 || p > 16) throw new WalletError('err.ksUnsupported', { what: 'scrypt r/p' });
  } else if (kdf === 'pbkdf2') {
    if (kp.prf !== 'hmac-sha256') throw new WalletError('err.ksUnsupported', { what: String(kp.prf) });
    if (!Number.isSafeInteger(kp.c) || kp.c < 1 || kp.c > MAX_PBKDF2_C) throw new WalletError('err.ksUnsupported', { what: `pbkdf2 c=${kp.c}` });
  } else {
    throw new WalletError('err.ksUnsupported', { what: String(c.kdf) });
  }
  if (!Number.isSafeInteger(kp.dklen) || kp.dklen < 32) throw new WalletError('err.ksFormat', { field: 'dklen' });
  const ciphertext = unhex(c.ciphertext, 'ciphertext');
  if (ciphertext.length !== 32) throw new WalletError('err.ksFormat', { field: 'ciphertext' });
  let address;
  if (typeof ks.address === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(ks.address)) {
    address = getAddress(ks.address.startsWith('0x') ? ks.address : '0x' + ks.address);
  }
  return {
    address,
    kdf,
    kdfparams: kp,
    salt: unhex(kp.salt, 'salt'),
    iv: unhex(c.cipherparams?.iv, 'iv'),
    ciphertext,
    mac: unhex(c.mac, 'mac'),
  };
}

function deriveKey(parsed, passwordBytes, onProgress) {
  const { kdf, kdfparams: kp, salt } = parsed;
  if (kdf === 'scrypt') return scryptAsync(passwordBytes, salt, { N: kp.n, r: kp.r, p: kp.p, dkLen: kp.dklen, onProgress });
  return pbkdf2Async(sha256, passwordBytes, salt, { c: kp.c, dkLen: kp.dklen });
}

/**
 * Decrypts a V3 keystore and returns { privateKey, address }.
 * geth/MetaMask use the raw UTF-8 password while ethers applies NFKC first; a full-width
 * password typed with a CJK IME differs between the two, so both are tried.
 */
export async function decryptKeystore(json, password, { onProgress } = {}) {
  const parsed = parseKeystore(json);
  const candidates = [password];
  const nfkc = String(password).normalize('NFKC');
  if (nfkc !== password) candidates.push(nfkc);
  for (const pw of candidates) {
    const dk = await deriveKey(parsed, utf8ToBytes(pw), onProgress);
    if (!equalBytes(macOf(dk, parsed.ciphertext), parsed.mac)) continue;
    const pkBytes = ctr(dk.slice(0, 16), parsed.iv).decrypt(parsed.ciphertext);
    const privateKey = bytesToHex(pkBytes);
    const address = privateKeyToAddress(privateKey);
    if (parsed.address && parsed.address !== address) throw new WalletError('err.ksAddressMismatch');
    return { privateKey, address };
  }
  throw new WalletError('err.ksPassword');
}

export function keystoreFileName(address, date = new Date()) {
  const ts = date.toISOString().replace(/:/g, '-');
  return `UTC--${ts}--${address.slice(2).toLowerCase()}.json`;
}
