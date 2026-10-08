import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBigInt,
  hexToNumber,
  hexToString,
  numberToHex,
  parseAbi,
  serializeTransaction,
  trim,
} from 'viem';
import { ERC20_ABI, ERC721_ABI, ERC1155_ABI } from './tx.js';
import { WalletError } from './errors.js';

export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

const EXTRA_ABI = parseAbi([
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function name() view returns (string)',
  'function getL1Fee(bytes data) view returns (uint256)',
]);
const BYTES32_SYMBOL_ABI = parseAbi(['function symbol() view returns (bytes32)']);
const ERC721_IID = '0x80ac58cd';
const ERC1155_IID = '0xd9b67a26';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isTransient = (e) =>
  (e instanceof WalletError && (e.key === 'err.rpcNetwork' || (e.key === 'err.rpcHttp' && (e.params.status === 429 || e.params.status >= 500)))) ||
  (e instanceof RpcError && (e.code === -32005 || e.code === 429 || /rate.?limit|too many requests/i.test(e.message)));

export function createRpc(url, { timeoutMs = 20000, retryDelayMs = 800, fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
  let id = 0;
  async function once(method, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let json;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      json = await res.json().catch(() => undefined);
    } catch (e) {
      throw new WalletError(e?.name === 'AbortError' ? 'err.rpcTimeout' : 'err.rpcNetwork', { detail: e?.message ?? String(e) });
    } finally {
      clearTimeout(timer);
    }
    if (json?.error) throw new RpcError(String(json.error.message ?? 'RPC error'), json.error.code, json.error.data);
    if (!res.ok || !json || !('result' in json)) throw new WalletError('err.rpcHttp', { status: res.status });
    return json.result;
  }
  // Public endpoints rate-limit bursts; one retry hides most of that. Broadcasting is
  // never retried automatically, so a failure there is always reported as-is.
  async function call(method, params = []) {
    if (!/^https?:\/\/\S+$/i.test(url)) throw new WalletError('err.rpcUrl');
    try {
      return await once(method, params);
    } catch (e) {
      if (method === 'eth_sendRawTransaction' || !isTransient(e)) throw e;
      await sleep(retryDelayMs);
      return once(method, params);
    }
  }
  return { url, call };
}

export const getChainId = async (rpc) => hexToNumber(await rpc.call('eth_chainId'));

export async function assertChain(rpc, expected) {
  const actual = await getChainId(rpc);
  if (actual !== expected) throw new WalletError('err.chainMismatch', { actual, expected });
}

async function readContract(rpc, { address, abi, functionName, args = [] }) {
  const data = encodeFunctionData({ abi, functionName, args });
  const result = await rpc.call('eth_call', [{ to: address, data }, 'latest']);
  return decodeFunctionResult({ abi, functionName, args, data: result });
}

/**
 * EIP-1559 suggestion: tip = median of the last blocks' median tips, maxFee = 2 × baseFee
 * + tip (survives several full blocks of base-fee growth). Legacy chains get eth_gasPrice.
 */
export async function suggestFees(rpc, block) {
  const gasPrice = await rpc.call('eth_gasPrice').then(hexToBigInt, () => undefined);
  if (block.baseFeePerGas == null) {
    if (gasPrice === undefined) throw new WalletError('err.rpcHttp', { status: 'eth_gasPrice' });
    return { supports1559: false, gasPrice };
  }
  const baseFee = hexToBigInt(block.baseFeePerGas);
  let tip;
  try {
    const h = await rpc.call('eth_feeHistory', ['0x5', 'latest', [50]]);
    const rewards = (h?.reward ?? []).map((r) => hexToBigInt(r[0])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (rewards.length) tip = rewards[rewards.length >> 1];
  } catch {
    // fall through
  }
  if (tip === undefined) tip = await rpc.call('eth_maxPriorityFeePerGas').then(hexToBigInt, () => 1_000_000_000n);
  return { supports1559: true, baseFee, tip, maxFee: baseFee * 2n + tip, gasPrice };
}

export async function getAccountInfo(rpc, address, expectedChainId) {
  const chainId = await getChainId(rpc);
  if (expectedChainId && chainId !== expectedChainId) throw new WalletError('err.chainMismatch', { actual: chainId, expected: expectedChainId });
  const [block, balance, nonce] = await Promise.all([
    rpc.call('eth_getBlockByNumber', ['latest', false]),
    rpc.call('eth_getBalance', [address, 'latest']),
    rpc.call('eth_getTransactionCount', [address, 'pending']),
  ]);
  const fees = await suggestFees(rpc, block);
  return {
    chainId,
    address,
    blockNumber: hexToNumber(block.number),
    blockTime: hexToNumber(block.timestamp),
    balance: hexToBigInt(balance),
    nonce: hexToNumber(nonce),
    fees,
  };
}

/** Strips control and bidi-override characters that could disguise a token name. */
export const cleanLabel = (s, max = 24) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim()
    .slice(0, max);

const rethrowTransport = (e) => {
  if (e instanceof WalletError) throw e;
};

async function readSymbol(rpc, token) {
  try {
    return await readContract(rpc, { address: token, abi: ERC20_ABI, functionName: 'symbol' });
  } catch (e) {
    rethrowTransport(e);
    // Old tokens (e.g. MKR) return bytes32.
    const raw = await readContract(rpc, { address: token, abi: BYTES32_SYMBOL_ABI, functionName: 'symbol' }).catch((e2) => {
      rethrowTransport(e2);
      return undefined;
    });
    return raw ? hexToString(trim(raw, { dir: 'right' })) : '';
  }
}

async function requireCode(rpc, address) {
  const code = await rpc.call('eth_getCode', [address, 'latest']);
  if (!code || code === '0x') throw new WalletError('err.noContract');
}

export async function getTokenInfo(rpc, token, owner) {
  await requireCode(rpc, token);
  let decimals;
  try {
    decimals = Number(await readContract(rpc, { address: token, abi: ERC20_ABI, functionName: 'decimals' }));
  } catch (e) {
    rethrowTransport(e);
    throw new WalletError('err.notErc20');
  }
  const [symbol, balance] = await Promise.all([
    readSymbol(rpc, token),
    owner ? readContract(rpc, { address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }) : undefined,
  ]);
  return { decimals, symbol: cleanLabel(symbol, 16), balance };
}

export async function getNftInfo(rpc, contract, tokenId, owner) {
  await requireCode(rpc, contract);
  const supports = (iid) =>
    readContract(rpc, { address: contract, abi: EXTRA_ABI, functionName: 'supportsInterface', args: [iid] }).catch((e) => {
      rethrowTransport(e);
      return false;
    });
  const [is721, is1155, name] = await Promise.all([
    supports(ERC721_IID),
    supports(ERC1155_IID),
    readContract(rpc, { address: contract, abi: EXTRA_ABI, functionName: 'name' }).catch(() => ''),
  ]);
  const label = cleanLabel(name, 40);
  if (is721) {
    // ownerOf reverts for a token that does not exist.
    const holder = await readContract(rpc, { address: contract, abi: ERC721_ABI, functionName: 'ownerOf', args: [tokenId] }).catch((e) => {
      rethrowTransport(e);
      return undefined;
    });
    return { standard: 'erc721', name: label, holder, owned: !!holder && !!owner && holder.toLowerCase() === owner.toLowerCase() };
  }
  if (is1155) {
    const balance = owner ? await readContract(rpc, { address: contract, abi: ERC1155_ABI, functionName: 'balanceOf', args: [owner, tokenId] }) : undefined;
    return { standard: 'erc1155', name: label, balance };
  }
  throw new WalletError('err.notNft');
}

export async function estimateGas(rpc, { from, to, value = 0n, data }) {
  const params = { from, to, value: numberToHex(value) };
  if (data) params.data = data;
  return hexToBigInt(await rpc.call('eth_estimateGas', [params]));
}

/** L1 data fee on OP-stack / Scroll chains, charged on top of gas × fee. */
export async function getL1Fee(rpc, oracle, unsignedTx) {
  const data = encodeFunctionData({ abi: EXTRA_ABI, functionName: 'getL1Fee', args: [serializeTransaction(unsignedTx)] });
  return hexToBigInt(await rpc.call('eth_call', [{ to: oracle, data }, 'latest']));
}

export const sendRawTransaction = (rpc, raw) => rpc.call('eth_sendRawTransaction', [raw]);

export async function waitForReceipt(rpc, hash, { timeoutMs = 180_000, intervalMs = 3000, onTick, isCancelled } = {}) {
  const start = Date.now();
  for (;;) {
    const r = await rpc.call('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r?.blockNumber) {
      return {
        status: r.status === '0x1' ? 'success' : 'reverted',
        blockNumber: hexToNumber(r.blockNumber),
        gasUsed: hexToBigInt(r.gasUsed),
        effectiveGasPrice: r.effectiveGasPrice ? hexToBigInt(r.effectiveGasPrice) : undefined,
      };
    }
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs || isCancelled?.()) return null;
    onTick?.(elapsed);
    await sleep(intervalMs);
  }
}

/** Best-effort revert reason: replays the call on the parent block's state. */
export async function getRevertReason(rpc, { from, to, data, value }, blockNumber) {
  try {
    await rpc.call('eth_call', [{ from, to, data, value: numberToHex(value ?? 0n) }, numberToHex(Math.max(0, blockNumber - 1))]);
    return '';
  } catch (e) {
    return explainRevert(e);
  }
}

export function explainRevert(e) {
  const data = typeof e?.data === 'string' ? e.data : e?.data?.data;
  if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}/.test(data)) {
    try {
      const d = decodeErrorResult({ data });
      return d.errorName === 'Error' ? String(d.args[0]) : `${d.errorName}(${d.args.join(', ')})`;
    } catch {
      // custom error we have no ABI for
    }
  }
  return e?.message ?? String(e);
}
