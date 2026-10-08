// What travels through QR codes / copy-paste between the online and the offline device.
//   address       plain checksummed address (or EIP-681 "ethereum:0x…")
//   tx request    {"oeww":"tx","v":1,…}   online watch-only device → offline signer
//   signed tx     raw hex "0x02f8…"        offline signer → online device (broadcast)
//   msg request   {"oeww":"msg","v":1,…}  online watch-only device → offline signer
//   signature     {"address","msg","sig","version":"2"} (MyCrypto/MEW signed-message format)
import { parseAddress } from './keys.js';
import { ASSETS } from './tx.js';

const MAX_PAYLOAD = 8000;
const REQ_FIELDS = ['chainId', 'chainName', 'nativeSymbol', 'symbol', 'from', 'asset', 'token', 'decimals', 'tokenId', 'to', 'amount', 'nonce', 'gas', 'feeType', 'maxFee', 'tip', 'gasPrice'];

export function encodeTxRequest(req) {
  const out = { oeww: 'tx', v: 1 };
  for (const k of REQ_FIELDS) {
    const v = req[k];
    if (v !== undefined && v !== null && v !== '') out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return JSON.stringify(out);
}

export const encodeMsgRequest = ({ from, message }) => JSON.stringify({ oeww: 'msg', v: 1, from, msg: message });

export const encodeSignature = ({ address, message, signature }) =>
  JSON.stringify({ address, msg: message, sig: signature, version: '2' });

/**
 * Upper-case hex lets the QR encoder use alphanumeric mode, which is ~30% denser than
 * byte mode, so the code stays easy to scan. geth and our own decoder accept "0X…".
 */
export const signedTxForQr = (raw) => raw.toUpperCase();

const isStr = (v, max = 200) => typeof v === 'string' && v.length <= max;
const optStr = (v, max) => v === undefined || isStr(v, max);

function validTxRequest(o) {
  if (!Number.isSafeInteger(o.chainId) || o.chainId <= 0) return false;
  if (!ASSETS.includes(o.asset)) return false;
  if (!isStr(o.to, 100)) return false;
  if (!['1559', 'legacy'].includes(o.feeType)) return false;
  for (const k of ['chainName', 'nativeSymbol', 'symbol', 'from', 'token', 'tokenId', 'amount', 'nonce', 'gas', 'maxFee', 'tip', 'gasPrice']) {
    if (!optStr(o[k] === undefined ? undefined : String(o[k]), 100)) return false;
  }
  return o.decimals === undefined || Number.isSafeInteger(Number(o.decimals));
}

/** Recognizes any of the payloads above; returns { type, … } with type 'unknown' otherwise. */
export function decodePayload(input) {
  const text = String(input ?? '').trim();
  if (!text || text.length > MAX_PAYLOAD) return { type: 'unknown' };

  if (text.startsWith('{')) {
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return { type: 'unknown' };
    }
    if (!o || typeof o !== 'object') return { type: 'unknown' };
    if (o.oeww === 'tx' && o.v === 1 && validTxRequest(o)) {
      const req = {};
      for (const k of REQ_FIELDS) if (o[k] !== undefined) req[k] = k === 'chainId' ? o[k] : String(o[k]);
      return { type: 'txRequest', request: req };
    }
    if (o.oeww === 'msg' && o.v === 1 && isStr(o.msg, MAX_PAYLOAD) && optStr(o.from, 100)) {
      return { type: 'msgRequest', from: o.from, message: o.msg };
    }
    if (isStr(o.address, 100) && isStr(o.msg, MAX_PAYLOAD) && isStr(o.sig, 200)) {
      return { type: 'signature', address: o.address, message: o.msg, signature: o.sig };
    }
    return { type: 'unknown' };
  }

  if (/^0x([0-9a-f]{2})+$/i.test(text) && text.length > 42) return { type: 'signedTx', raw: text.toLowerCase() };

  const addr = parseAddress(text);
  if (addr?.checksum === 'invalid') return { type: 'badAddress' };
  if (addr) return { type: 'address', address: addr.address, chainId: addr.chainId };
  return { type: 'unknown' };
}
