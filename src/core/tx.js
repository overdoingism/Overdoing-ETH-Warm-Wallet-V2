import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  size,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount, parseGwei, parseInteger } from './amount.js';
import { parseAddress } from './keys.js';
import { WalletError } from './errors.js';

export const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
export const ERC721_ABI = parseAbi([
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
export const ERC1155_ABI = parseAbi([
  'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
]);
// Everything we can explain to the user when reviewing calldata.
const DECODE_ABI = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
  'function approve(address spender, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
]);

export const ASSETS = ['native', 'erc20', 'erc721', 'erc1155'];
export const DEFAULT_GAS = { native: 21000, erc20: 100000, erc721: 200000, erc1155: 200000 };

/** Returns the checksummed address; a mixed-case address with a bad checksum is rejected. */
export function requireAddress(input, field) {
  const parsed = parseAddress(input);
  if (!parsed) throw new WalletError('err.address', { field });
  if (parsed.checksum === 'invalid') throw new WalletError('err.addressChecksum', { field });
  return parsed;
}

function buildFee(req) {
  if (req.feeType === 'legacy') {
    const gasPrice = parseGwei(req.gasPrice, 'gasPrice');
    if (gasPrice === 0n) throw new WalletError('err.feeZero');
    return { type: 'legacy', gasPrice };
  }
  const maxFeePerGas = parseGwei(req.maxFee, 'maxFee');
  const maxPriorityFeePerGas = parseGwei(req.tip, 'tip');
  if (maxFeePerGas === 0n) throw new WalletError('err.feeZero');
  if (maxPriorityFeePerGas > maxFeePerGas) throw new WalletError('err.tipAboveMax');
  return { type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas };
}

export function parseDecimals(input) {
  return Number(parseInteger(input, 'decimals', { max: 36n }));
}

/**
 * Turns a transfer request (the send form, or a request scanned from a watch-only device)
 * into an unsigned transaction. Every field is validated here, so the signer never signs
 * something the review dialog did not show.
 */
export function buildTransaction(req) {
  const chainId = Number(req.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new WalletError('err.chainId');
  if (!ASSETS.includes(req.asset)) throw new WalletError('err.asset');
  const recipient = requireAddress(req.to, 'to');
  const nonce = Number(parseInteger(req.nonce, 'nonce', { max: BigInt(Number.MAX_SAFE_INTEGER) }));
  const gas = parseInteger(req.gas, 'gas', { min: 21000n, max: 1_000_000_000n });
  const fee = buildFee(req);
  const notes = [];
  if (recipient.checksum === 'none') notes.push('warn.noChecksum');

  const summary = { asset: req.asset, chainId, recipient: recipient.address, nonce, gas };
  let to;
  let value = 0n;
  let data;

  if (req.asset === 'native') {
    value = parseAmount(req.amount, 18, 'amount');
    to = recipient.address;
    summary.amount = value;
    summary.decimals = 18;
  } else {
    const contract = requireAddress(req.token, 'token').address;
    to = contract;
    summary.contract = contract;
    if (req.asset === 'erc20') {
      const decimals = parseDecimals(req.decimals);
      const amount = parseAmount(req.amount, decimals, 'amount');
      data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [recipient.address, amount] });
      Object.assign(summary, { amount, decimals, symbol: String(req.symbol || '') });
    } else {
      const from = requireAddress(req.from, 'from').address;
      const tokenId = parseInteger(req.tokenId, 'tokenId', { hex: true });
      summary.tokenId = tokenId;
      if (req.asset === 'erc721') {
        data = encodeFunctionData({ abi: ERC721_ABI, functionName: 'safeTransferFrom', args: [from, recipient.address, tokenId] });
        summary.amount = 1n;
      } else {
        const amount = parseInteger(req.amount, 'amount', { min: 1n });
        data = encodeFunctionData({ abi: ERC1155_ABI, functionName: 'safeTransferFrom', args: [from, recipient.address, tokenId, amount, '0x'] });
        summary.amount = amount;
      }
    }
  }
  if (value === 0n && req.asset === 'native') notes.push('warn.zeroAmount');
  if ((req.asset === 'erc20' || req.asset === 'erc1155') && summary.amount === 0n) notes.push('warn.zeroAmount');
  if (summary.contract && summary.contract === recipient.address) notes.push('warn.toIsContract');

  const tx = { chainId, nonce, gas, to, value, ...fee };
  if (data) tx.data = data;
  summary.maxCost = maxCost(tx);
  return { tx, summary, notes };
}

export const maxCost = (tx) => BigInt(tx.gas) * BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? 0n);

export async function signTransaction(privateKey, tx) {
  const raw = await privateKeyToAccount(privateKey).signTransaction(tx);
  return { raw, hash: keccak256(raw) };
}

/** Parses a signed raw transaction and recovers its sender. */
export async function parseSignedTransaction(raw) {
  const hex = String(raw ?? '').trim();
  if (!/^0x([0-9a-fA-F]{2})+$/.test(hex)) throw new WalletError('err.signedTx');
  const normalized = hex.toLowerCase();
  let tx;
  try {
    tx = parseTransaction(normalized);
  } catch {
    throw new WalletError('err.signedTx');
  }
  if (tx.r === undefined || tx.s === undefined) throw new WalletError('err.notSigned');
  const from = await recoverTransactionAddress({ serializedTransaction: normalized });
  return { tx, from, raw: normalized, hash: keccak256(normalized) };
}

/**
 * Explains what a transaction does: plain transfer, token/NFT transfer, approval, or an
 * unknown contract call. Used for the signing review and for scanned transactions.
 */
export function describeTransaction(tx) {
  const data = tx.data ?? tx.input;
  const value = BigInt(tx.value ?? 0n);
  if (!tx.to) return { kind: 'deploy', value };
  const to = getAddress(tx.to);
  if (!data || data === '0x') return { kind: 'native', to, value };
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: DECODE_ABI, data });
  } catch {
    return { kind: 'call', to, value, data };
  }
  const { functionName: fn, args } = decoded;
  const item = DECODE_ABI.find((i) => i.name === fn && i.inputs.length === args.length);
  const extraData = size(data) > size(encodeFunctionData({ abi: [item], functionName: fn, args }));
  const base = { contract: to, value, extraData };
  if (fn === 'transfer') return { ...base, kind: 'erc20', recipient: args[0], amount: args[1] };
  if (fn === 'transferFrom') return { ...base, kind: 'transferFrom', owner: args[0], recipient: args[1], amount: args[2] };
  if (fn === 'safeTransferFrom' && args.length === 3) return { ...base, kind: 'erc721', owner: args[0], recipient: args[1], tokenId: args[2] };
  if (fn === 'safeTransferFrom') return { ...base, kind: 'erc1155', owner: args[0], recipient: args[1], tokenId: args[2], amount: args[3] };
  if (fn === 'approve') return { ...base, kind: 'approve', spender: args[0], amount: args[1] };
  return { ...base, kind: 'approveAll', operator: args[0], approved: args[1] };
}
