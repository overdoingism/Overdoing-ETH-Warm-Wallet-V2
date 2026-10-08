// Password-encrypted key storage in the browser (localStorage). Each entry is a standard
// V3 keystore, so it can be exported as-is and opened by other wallets.
import { getAddress } from 'viem';
import { encryptKeystore, decryptKeystore } from './keystore.js';
import { WalletError } from './errors.js';

export const VAULT_KEY = 'oeww.vault.v1';

export function createVault(storage) {
  const read = () => {
    let raw;
    try {
      raw = storage.getItem(VAULT_KEY);
    } catch {
      throw new WalletError('err.storage');
    }
    if (!raw) return [];
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter((e) => e && e.id && e.keystore) : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      storage.setItem(VAULT_KEY, JSON.stringify(list));
    } catch {
      throw new WalletError('err.storage');
    }
  };

  return {
    list: () => read().map(({ id, name, address, created }) => ({ id, name, address, created })),
    get: (id) => read().find((e) => e.id === id),

    async add(name, privateKey, password, opts) {
      const keystore = await encryptKeystore(privateKey, password, opts);
      const entry = {
        id: keystore.id,
        name: String(name || '').trim().slice(0, 40) || 'Wallet',
        address: getAddress('0x' + keystore.address),
        created: new Date().toISOString(),
        keystore,
      };
      write([...read(), entry]);
      return entry;
    },

    async unlock(id, password, opts) {
      const entry = read().find((e) => e.id === id);
      if (!entry) throw new WalletError('err.vaultMissing');
      return decryptKeystore(entry.keystore, password, opts);
    },

    remove(id) {
      write(read().filter((e) => e.id !== id));
    },
  };
}
