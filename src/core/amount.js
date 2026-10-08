import { formatUnits } from 'viem';
import { WalletError } from './errors.js';

const DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Parses a human-readable decimal string ("1.5") into base units (bigint).
 * Strict on purpose: no signs, exponents, thousands separators, and no silent
 * rounding — more fractional digits than `decimals` is an error.
 */
export function parseAmount(input, decimals, field = 'amount') {
  const s = String(input ?? '').trim();
  if (!DECIMAL_RE.test(s)) throw new WalletError('err.number', { field });
  const [int, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new WalletError('err.tooManyDecimals', { field, decimals });
  const value = BigInt((int || '0') + frac.padEnd(decimals, '0'));
  if (value > MAX_UINT256) throw new WalletError('err.range', { field });
  return value;
}

export const formatAmount = (value, decimals) => formatUnits(BigInt(value), decimals);

export const parseGwei = (input, field) => parseAmount(input, 9, field);
export const formatGwei = (wei) => formatUnits(BigInt(wei), 9);

/** Parses a non-negative integer, decimal or 0x-hex (token IDs are often shown in hex). */
export function parseInteger(input, field, { min = 0n, max = MAX_UINT256, hex = false } = {}) {
  const s = String(input ?? '').trim();
  let value;
  if (/^\d+$/.test(s)) value = BigInt(s);
  else if (hex && /^0x[0-9a-fA-F]+$/.test(s)) value = BigInt(s);
  else throw new WalletError('err.integer', { field });
  if (value < min || value > max) throw new WalletError('err.range', { field });
  return value;
}
