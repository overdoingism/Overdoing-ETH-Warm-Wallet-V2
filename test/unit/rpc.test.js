import { describe, expect, it } from 'vitest';
import { encodeErrorResult, parseAbi } from 'viem';
import { RpcError, cleanLabel, createRpc, explainRevert, getAccountInfo, getTokenInfo, suggestFees } from '../../src/core/rpc.js';

const ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

/** fetch stub answering from a method → result map (functions receive params). */
function fakeFetch(handlers, log = []) {
  return async (url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    log.push(method);
    const h = handlers[method];
    if (h === undefined) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }));
    const result = typeof h === 'function' ? h(params) : h;
    if (result instanceof Error) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: result.message, data: result.data } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
}

const BLOCK_1559 = { number: '0x10', timestamp: '0x6500', baseFeePerGas: '0x3b9aca00' }; // 1 gwei

describe('rpc', () => {
  it('reads account info and suggests EIP-1559 fees', async () => {
    const rpc = createRpc('https://rpc.test', {
      fetchFn: fakeFetch({
        eth_chainId: '0x1',
        eth_getBlockByNumber: BLOCK_1559,
        eth_getBalance: '0xde0b6b3a7640000',
        eth_getTransactionCount: (p) => (p[1] === 'pending' ? '0x5' : '0x0'),
        eth_gasPrice: '0x77359400',
        eth_feeHistory: { reward: [['0x1'], ['0x5f5e100'], ['0x3']] },
      }),
    });
    const info = await getAccountInfo(rpc, ADDR, 1);
    expect(info).toMatchObject({ chainId: 1, blockNumber: 16, balance: 10n ** 18n, nonce: 5 });
    expect(info.fees).toEqual({ supports1559: true, baseFee: 1_000_000_000n, tip: 3n, maxFee: 2_000_000_003n, gasPrice: 2_000_000_000n });
  });

  it('falls back to eth_maxPriorityFeePerGas, and to gasPrice on legacy chains', async () => {
    const rpc = createRpc('https://rpc.test', { fetchFn: fakeFetch({ eth_maxPriorityFeePerGas: '0x2', eth_gasPrice: '0x9' }) });
    expect(await suggestFees(rpc, BLOCK_1559)).toMatchObject({ tip: 2n, maxFee: 2_000_000_002n });
    expect(await suggestFees(rpc, { number: '0x1' })).toEqual({ supports1559: false, gasPrice: 9n });
  });

  it('refuses an RPC that serves a different chain', async () => {
    const rpc = createRpc('https://rpc.test', { fetchFn: fakeFetch({ eth_chainId: '0x38' }) });
    await expect(getAccountInfo(rpc, ADDR, 1)).rejects.toMatchObject({ key: 'err.chainMismatch', params: { actual: 56, expected: 1 } });
  });

  it('surfaces RPC, HTTP, network and timeout errors', async () => {
    const err = createRpc('https://rpc.test', { fetchFn: fakeFetch({ eth_sendRawTransaction: new Error('nonce too low') }) });
    await expect(err.call('eth_sendRawTransaction', ['0x00'])).rejects.toBeInstanceOf(RpcError);
    const http = createRpc('https://rpc.test', { fetchFn: async () => new Response('<html>', { status: 502 }) });
    await expect(http.call('eth_chainId')).rejects.toMatchObject({ key: 'err.rpcHttp', params: { status: 502 } });
    const down = createRpc('https://rpc.test', { fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
    await expect(down.call('eth_chainId')).rejects.toMatchObject({ key: 'err.rpcNetwork' });
    const slow = createRpc('https://rpc.test', {
      timeoutMs: 20,
      fetchFn: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    await expect(slow.call('eth_chainId')).rejects.toMatchObject({ key: 'err.rpcTimeout' });
    await expect(createRpc('ftp://x').call('eth_chainId')).rejects.toMatchObject({ key: 'err.rpcUrl' });
  });

  it('retries one transient failure on reads, never on broadcasts', async () => {
    let calls = 0;
    const flaky = async (url, init) => {
      calls++;
      if (calls === 1) return new Response('busy', { status: 429 });
      return fakeFetch({ eth_chainId: '0x1', eth_sendRawTransaction: '0xabc' })(url, init);
    };
    expect(await createRpc('https://rpc.test', { fetchFn: flaky, retryDelayMs: 1 }).call('eth_chainId')).toBe('0x1');
    expect(calls).toBe(2);
    calls = 0;
    await expect(createRpc('https://rpc.test', { fetchFn: flaky, retryDelayMs: 1 }).call('eth_sendRawTransaction', ['0x00'])).rejects.toMatchObject({ key: 'err.rpcHttp' });
    expect(calls).toBe(1);
  });

  it('does not mistake network trouble for "not an ERC20"', async () => {
    let n = 0;
    const fetchFn = async (url, init) => {
      if (++n === 1) return fakeFetch({ eth_getCode: '0x6000' })(url, init);
      throw new TypeError('Failed to fetch');
    };
    await expect(getTokenInfo(createRpc('https://rpc.test', { fetchFn, retryDelayMs: 1 }), '0xdAC17F958D2ee523a2206206994597C13D831ec7')).rejects.toMatchObject({ key: 'err.rpcNetwork' });
    const reverting = createRpc('https://rpc.test', { fetchFn: fakeFetch({ eth_getCode: '0x6000', eth_call: new Error('execution reverted') }) });
    await expect(getTokenInfo(reverting, '0xdAC17F958D2ee523a2206206994597C13D831ec7')).rejects.toMatchObject({ key: 'err.notErc20' });
  });

  it('decodes revert reasons and cleans token labels', () => {
    const data = encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['ERC20: transfer amount exceeds balance'] });
    expect(explainRevert(new RpcError('execution reverted', 3, data))).toBe('ERC20: transfer amount exceeds balance');
    expect(explainRevert(new RpcError('boom', 3))).toBe('boom');
    expect(cleanLabel('US\u202eDT\u0000')).toBe('USDT');
  });
});
