import { describe, expect, it } from 'vitest';
import { Interface, Transaction, Wallet } from 'ethers';
import { buildTransaction, describeTransaction, parseSignedTransaction, signTransaction } from '../../src/core/tx.js';
import { formatAmount, parseAmount, parseInteger } from '../../src/core/amount.js';

const PK = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const FROM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const TO = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TOKEN = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const base = { chainId: 1, from: FROM, to: TO, nonce: '7', gas: '100000', feeType: '1559', maxFee: '30', tip: '1.5' };
const iface = new Interface([
  'function transfer(address,uint256)',
  'function safeTransferFrom(address,address,uint256)',
  'function safeTransferFrom(address,address,uint256,uint256,bytes)',
  'function approve(address,uint256)',
  'function setApprovalForAll(address,bool)',
]);

describe('amount parsing', () => {
  it('parses strictly', () => {
    expect(parseAmount('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseAmount('.5', 6)).toBe(500_000n);
    expect(parseAmount('7.', 6)).toBe(7_000_000n);
    expect(parseAmount(' 0 ', 6)).toBe(0n);
    for (const bad of ['', '-1', '1e3', '1,000', '0x10', '1.2.3', 'abc']) expect(() => parseAmount(bad, 18), bad).toThrowError('err.number');
    expect(() => parseAmount('1.0000001', 6)).toThrowError('err.tooManyDecimals');
    expect(formatAmount(1_500_000n, 6)).toBe('1.5');
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001');
  });
  it('parses integers (decimal or hex token IDs)', () => {
    expect(parseInteger('42', 'x')).toBe(42n);
    expect(parseInteger('0xff', 'x', { hex: true })).toBe(255n);
    expect(() => parseInteger('0xff', 'x')).toThrowError('err.integer');
    expect(() => parseInteger('5', 'x', { min: 6n })).toThrowError('err.range');
  });
});

describe('buildTransaction', () => {
  it('reproduces the EIP-155 example transaction', async () => {
    const { tx } = buildTransaction({
      chainId: 1, asset: 'native', to: '0x3535353535353535353535353535353535353535', amount: '1',
      nonce: '9', gas: '21000', feeType: 'legacy', gasPrice: '20',
    });
    const { raw } = await signTransaction('0x' + '46'.repeat(32), tx);
    expect(raw).toBe(
      '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83',
    );
  });

  it('signs EIP-1559 transfers identically to ethers', async () => {
    const { tx, summary } = buildTransaction({ ...base, asset: 'native', amount: '0.25', gas: '21000' });
    expect(summary.maxCost).toBe(21000n * 30_000_000_000n);
    const { raw, hash } = await signTransaction(PK, tx);
    const theirs = await new Wallet(PK).signTransaction({
      type: 2, chainId: 1, nonce: 7, to: TO, value: 250_000_000_000_000_000n, gasLimit: 21000n,
      maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_500_000_000n,
    });
    expect(raw).toBe(theirs);
    expect(hash).toBe(Transaction.from(theirs).hash);
    const parsed = await parseSignedTransaction(raw.toUpperCase().replace('0X', '0x'));
    expect(parsed.from).toBe(FROM);
    expect(describeTransaction(parsed.tx)).toMatchObject({ kind: 'native', to: TO, value: 250_000_000_000_000_000n });
  });

  it('encodes ERC20, ERC721 and ERC1155 transfers', () => {
    const erc20 = buildTransaction({ ...base, asset: 'erc20', token: TOKEN, decimals: '6', symbol: 'USDT', amount: '1.5' });
    expect(erc20.tx).toMatchObject({ to: TOKEN, value: 0n, data: iface.encodeFunctionData('transfer', [TO, 1_500_000n]) });
    expect(describeTransaction(erc20.tx)).toMatchObject({ kind: 'erc20', contract: TOKEN, recipient: TO, amount: 1_500_000n, extraData: false });

    const nft = buildTransaction({ ...base, asset: 'erc721', token: TOKEN, tokenId: '0x10' });
    expect(nft.tx.data).toBe(iface.encodeFunctionData('safeTransferFrom(address,address,uint256)', [FROM, TO, 16n]));
    expect(describeTransaction(nft.tx)).toMatchObject({ kind: 'erc721', owner: FROM, recipient: TO, tokenId: 16n });

    const multi = buildTransaction({ ...base, asset: 'erc1155', token: TOKEN, tokenId: '3', amount: '5' });
    expect(multi.tx.data).toBe(iface.encodeFunctionData('safeTransferFrom(address,address,uint256,uint256,bytes)', [FROM, TO, 3n, 5n, '0x']));
    expect(describeTransaction(multi.tx)).toMatchObject({ kind: 'erc1155', tokenId: 3n, amount: 5n });
  });

  it('validates input', () => {
    const bad = (patch) => () => buildTransaction({ ...base, asset: 'native', amount: '1', ...patch });
    expect(bad({ to: TO.replace('aAeb', 'aaEb') })).toThrowError('err.addressChecksum');
    expect(bad({ to: '0x1234' })).toThrowError('err.address');
    expect(bad({ tip: '31' })).toThrowError('err.tipAboveMax');
    expect(bad({ maxFee: '0', tip: '0' })).toThrowError('err.feeZero');
    expect(bad({ gas: '20999' })).toThrowError('err.range');
    expect(bad({ nonce: '-1' })).toThrowError('err.integer');
    expect(bad({ amount: '0.0000000000000000001' })).toThrowError('err.tooManyDecimals');
    expect(bad({ asset: 'erc721', token: TOKEN, tokenId: '1', from: undefined })).toThrowError('err.address');
    expect(bad({ asset: 'erc20', token: TOKEN, decimals: '6', amount: '1.1234567' })).toThrowError('err.tooManyDecimals');
    expect(bad({ chainId: 0 })).toThrowError('err.chainId');
  });

  it('collects non-fatal notes', () => {
    expect(buildTransaction({ ...base, asset: 'native', amount: '0', to: TO.toLowerCase() }).notes).toEqual(['warn.noChecksum', 'warn.zeroAmount']);
    expect(buildTransaction({ ...base, asset: 'erc20', token: TOKEN, decimals: 6, amount: '1', to: TOKEN }).notes).toContain('warn.toIsContract');
  });
});

describe('describeTransaction', () => {
  it('explains approvals, unknown calls, deployments and trailing data', () => {
    const approve = iface.encodeFunctionData('approve', [TO, 0n]);
    expect(describeTransaction({ to: TOKEN, data: approve })).toMatchObject({ kind: 'approve', spender: TO, amount: 0n });
    expect(describeTransaction({ to: TOKEN, data: iface.encodeFunctionData('setApprovalForAll', [TO, true]) })).toMatchObject({ kind: 'approveAll', operator: TO, approved: true });
    expect(describeTransaction({ to: TOKEN, data: '0xdeadbeef' })).toMatchObject({ kind: 'call' });
    expect(describeTransaction({ to: null, data: '0x6000' })).toMatchObject({ kind: 'deploy' });
    expect(describeTransaction({ to: TOKEN, data: approve + 'ff' })).toMatchObject({ kind: 'approve', extraData: true });
  });

  it('rejects garbage and unsigned transactions', async () => {
    await expect(parseSignedTransaction('0x1234')).rejects.toThrowError('err.signedTx');
    await expect(parseSignedTransaction('hello')).rejects.toThrowError('err.signedTx');
    const unsigned = Transaction.from({ type: 2, chainId: 1, nonce: 1, to: TO, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }).unsignedSerialized;
    await expect(parseSignedTransaction(unsigned)).rejects.toThrowError('err.notSigned');
  });
});
