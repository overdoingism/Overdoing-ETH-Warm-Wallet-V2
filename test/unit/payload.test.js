import { describe, expect, it } from 'vitest';
import { Wallet, getBytes } from 'ethers';
import { decodePayload, encodeMsgRequest, encodeSignature, encodeTxRequest, signedTxForQr } from '../../src/core/payload.js';
import { recoverSigner, signMessage } from '../../src/core/message.js';

const PK = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

describe('QR payloads', () => {
  it('round-trips a transfer request', () => {
    const req = {
      chainId: 1, chainName: 'Ethereum', symbol: 'USDT', from: ADDR, asset: 'erc20', token: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      decimals: 6, to: ADDR, amount: '12.5', nonce: 3, gas: 65000n, feeType: '1559', maxFee: '2.5', tip: '0.1', tokenId: '',
    };
    const text = encodeTxRequest(req);
    expect(JSON.parse(text)).not.toHaveProperty('tokenId');
    const out = decodePayload(text);
    expect(out.type).toBe('txRequest');
    expect(out.request).toEqual({ ...req, decimals: '6', nonce: '3', gas: '65000', tokenId: undefined });
  });

  it('rejects malformed requests', () => {
    const ok = JSON.parse(encodeTxRequest({ chainId: 1, asset: 'native', to: ADDR, feeType: '1559', amount: '1' }));
    expect(decodePayload(JSON.stringify(ok)).type).toBe('txRequest');
    for (const patch of [{ chainId: '1' }, { asset: 'evil' }, { feeType: 'x' }, { to: 5 }, { amount: 'x'.repeat(500) }, { v: 2 }]) {
      expect(decodePayload(JSON.stringify({ ...ok, ...patch })).type, JSON.stringify(patch)).toBe('unknown');
    }
  });

  it('recognizes addresses, signed transactions and junk', () => {
    expect(decodePayload(ADDR.toLowerCase())).toEqual({ type: 'address', address: ADDR, chainId: undefined });
    expect(decodePayload(`ethereum:${ADDR}@10`)).toMatchObject({ type: 'address', chainId: 10 });
    expect(decodePayload(ADDR.replace('c7536E', 'C7536e')).type).toBe('badAddress');
    expect(decodePayload(signedTxForQr('0x02f86c0180'.padEnd(120, 'a')))).toMatchObject({ type: 'signedTx', raw: '0x02f86c0180'.padEnd(120, 'a') });
    expect(decodePayload('hello').type).toBe('unknown');
    expect(decodePayload('{"a":1}').type).toBe('unknown');
    expect(decodePayload('x'.repeat(9000)).type).toBe('unknown');
  });

  it('signs messages like ethers and round-trips the signature payload', async () => {
    for (const message of ['hello', '你好，世界', '0x48656c6c6f']) {
      const sig = await signMessage(PK, message);
      const expected = await new Wallet(PK).signMessage(message.startsWith('0x') ? getBytes(message) : message);
      expect(sig).toBe(expected);
      expect(await recoverSigner(message, sig)).toBe(ADDR);
      const decoded = decodePayload(encodeSignature({ address: ADDR, message, signature: sig }));
      expect(decoded).toEqual({ type: 'signature', address: ADDR, message, signature: sig });
    }
    expect(decodePayload(encodeMsgRequest({ from: ADDR, message: 'hi' }))).toEqual({ type: 'msgRequest', from: ADDR, message: 'hi' });
    await expect(recoverSigner('x', '0x1234')).rejects.toThrowError('err.signature');
    await expect(signMessage(PK, '')).rejects.toThrowError('err.messageEmpty');
  });
});
