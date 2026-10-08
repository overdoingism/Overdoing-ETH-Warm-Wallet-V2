// personal_sign (EIP-191). Like MetaMask, a 0x-prefixed hex message is signed as raw bytes;
// anything else is signed as UTF-8 text.
import { recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WalletError } from './errors.js';

export const isHexMessage = (msg) => /^0x([0-9a-fA-F]{2})+$/.test(msg);
const toViemMessage = (msg) => (isHexMessage(msg) ? { raw: msg } : msg);

export async function signMessage(privateKey, message) {
  if (!message) throw new WalletError('err.messageEmpty');
  return privateKeyToAccount(privateKey).signMessage({ message: toViemMessage(message) });
}

export async function recoverSigner(message, signature) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new WalletError('err.signature');
  try {
    return await recoverMessageAddress({ message: toViemMessage(message), signature });
  } catch {
    throw new WalletError('err.signature');
  }
}
