import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { wordlist as traditionalChinese } from '@scure/bip39/wordlists/traditional-chinese';
import { wordlist as simplifiedChinese } from '@scure/bip39/wordlists/simplified-chinese';
import { HDKey } from '@scure/bip32';
import { bytesToHex, getAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { WalletError } from './errors.js';

export const DEFAULT_PATH = "m/44'/60'/0'/0/0";
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HARDENED = 0x80000000;

// The wordlist only matters for the checksum check: the BIP39 seed is derived from the
// sentence text itself, so mnemonics in other languages still derive correctly.
const WORDLISTS = [
  ['english', english],
  ['traditionalChinese', traditionalChinese],
  ['simplifiedChinese', simplifiedChinese],
];
const MNEMONIC_LENGTHS = [12, 15, 18, 21, 24];
const HAN_RE = /\p{Script=Han}/u;

/**
 * Canonical BIP39 sentence: NFKD, lower case, single spaces. Chinese words are single
 * characters, so a Chinese phrase typed without spaces is split per character.
 */
export function normalizeMnemonic(text) {
  const s = String(text ?? '').normalize('NFKD').trim().toLowerCase();
  if (HAN_RE.test(s)) return Array.from(s.replace(/\s+/g, '')).join(' ');
  return s.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Checks a mnemonic against the bundled wordlists.
 * status: 'ok' | 'badLength' | 'badChecksum' (all words known, checksum wrong — likely a
 * typo or wrong order) | 'unknownWords' (typo, or a wordlist that is not bundled).
 */
export function inspectMnemonic(text) {
  const phrase = normalizeMnemonic(text);
  const words = phrase ? phrase.split(' ') : [];
  const base = { phrase, wordCount: words.length };
  if (!MNEMONIC_LENGTHS.includes(words.length)) return { ...base, status: 'badLength' };
  for (const [name, list] of WORDLISTS) {
    if (validateMnemonic(phrase, list)) return { ...base, status: 'ok', wordlist: name };
  }
  let best;
  for (const [name, list] of WORDLISTS) {
    const known = new Set(list);
    const unknown = words.filter((w) => !known.has(w));
    if (unknown.length === 0) return { ...base, status: 'badChecksum', wordlist: name };
    if (!best || unknown.length < best.unknown.length) best = { wordlist: name, unknown };
  }
  return { ...base, status: 'unknownWords', unknownWords: [...new Set(best.unknown)] };
}

/** Normalizes the path (h/H/’ → ') and validates it; returns the canonical string. */
export function normalizePath(path) {
  const p = String(path ?? '').trim().replace(/^M/, 'm').replace(/[hH’‘′]/g, "'");
  if (!/^m(\/\d+'?)+$/.test(p)) throw new WalletError('err.path');
  for (const seg of p.split('/').slice(1)) {
    if (parseInt(seg, 10) >= HARDENED) throw new WalletError('err.path');
  }
  return p;
}

export function deriveFromMnemonic(phrase, passphrase = '', path = DEFAULT_PATH) {
  const cleanPath = normalizePath(path);
  const seed = mnemonicToSeedSync(normalizeMnemonic(phrase), passphrase);
  const node = HDKey.fromMasterSeed(seed).derive(cleanPath);
  const privateKey = bytesToHex(node.privateKey);
  return { privateKey, address: privateKeyToAddress(privateKey), path: cleanPath };
}

const PK_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

export const looksLikePrivateKey = (text) => PK_RE.test(String(text ?? '').trim());

/** Returns { privateKey, address } for a 32-byte hex key, or throws. */
export function parsePrivateKey(text) {
  const s = String(text ?? '').trim();
  if (!PK_RE.test(s)) throw new WalletError('err.privateKey');
  const privateKey = (s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s).toLowerCase();
  const n = BigInt('0x' + privateKey);
  if (n === 0n || n >= SECP256K1_N) throw new WalletError('err.privateKey');
  const hex = '0x' + privateKey;
  return { privateKey: hex, address: privateKeyToAddress(hex) };
}

/**
 * Parses an address typed by a human or read from a QR code: tolerates spaces, a missing
 * 0x, and EIP-681 "ethereum:0x…@chainId" URIs.
 * checksum: 'valid' | 'none' (all one case, nothing to verify) | 'invalid' (mixed case that
 * fails EIP-55 — almost certainly a typo).
 */
export function parseAddress(text) {
  let s = String(text ?? '').replace(/\s+/g, '');
  let chainId;
  const uri = s.match(/^ethereum:(?:pay-)?((?:0x)?[0-9a-fA-F]{40})(?:@(\d+))?(?:[/?].*)?$/i);
  if (uri) {
    s = uri[1];
    if (uri[2]) chainId = Number(uri[2]);
  }
  if (/^[0-9a-fA-F]{40}$/.test(s)) s = '0x' + s;
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(s)) return null;
  const body = s.slice(2);
  const address = getAddress('0x' + body.toLowerCase());
  let checksum;
  if (body === body.toLowerCase() || body === body.toUpperCase()) checksum = 'none';
  else checksum = address.slice(2) === body ? 'valid' : 'invalid';
  return { address, checksum, chainId };
}

/** Rough classification of what was pasted into the account box. */
export function classifyInput(text) {
  const s = String(text ?? '').trim();
  if (!s) return 'empty';
  if (s.startsWith('{')) return 'keystore';
  if (PK_RE.test(s)) return 'privateKey';
  if (parseAddress(s)) return 'address';
  return 'mnemonic';
}
