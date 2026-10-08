import { WalletError } from './errors.js';

// Built-in networks. Every RPC below was checked for CORS (works from a file:// page)
// and for eth_feeHistory / baseFeePerGas support. Users can add their own networks.
const OP_ORACLE = '0x420000000000000000000000000000000000000F';
const SCROLL_ORACLE = '0x5300000000000000000000000000000000000002';

// l1Oracle: OP-stack style GasPriceOracle (getL1Fee(bytes)); the L1 data fee is charged
// on top of gasLimit × fee, so "send max" must leave room for it.
export const CHAINS = [
  { id: 1, name: 'Ethereum', symbol: 'ETH', rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'], explorer: 'https://etherscan.io' },
  { id: 42161, name: 'Arbitrum One', symbol: 'ETH', rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'], explorer: 'https://arbiscan.io' },
  { id: 10, name: 'OP Mainnet', symbol: 'ETH', rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'], explorer: 'https://optimistic.etherscan.io', l1Oracle: OP_ORACLE },
  { id: 8453, name: 'Base', symbol: 'ETH', rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], explorer: 'https://basescan.org', l1Oracle: OP_ORACLE },
  { id: 137, name: 'Polygon PoS', symbol: 'POL', rpc: ['https://polygon.drpc.org', 'https://polygon.gateway.tenderly.co', 'https://polygon-bor-rpc.publicnode.com'], explorer: 'https://polygonscan.com' },
  { id: 56, name: 'BNB Smart Chain', symbol: 'BNB', rpc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'], explorer: 'https://bscscan.com' },
  { id: 43114, name: 'Avalanche C-Chain', symbol: 'AVAX', rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'], explorer: 'https://snowtrace.io' },
  { id: 100, name: 'Gnosis', symbol: 'XDAI', rpc: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'], explorer: 'https://gnosisscan.io' },
  { id: 59144, name: 'Linea', symbol: 'ETH', rpc: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'], explorer: 'https://lineascan.build' },
  { id: 534352, name: 'Scroll', symbol: 'ETH', rpc: ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com'], explorer: 'https://scrollscan.com', l1Oracle: SCROLL_ORACLE },
  { id: 324, name: 'zkSync Era', symbol: 'ETH', rpc: ['https://mainnet.era.zksync.io'], explorer: 'https://explorer.zksync.io' },
  { id: 130, name: 'Unichain', symbol: 'ETH', rpc: ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'], explorer: 'https://uniscan.xyz', l1Oracle: OP_ORACLE },
  { id: 5000, name: 'Mantle', symbol: 'MNT', rpc: ['https://rpc.mantle.xyz'], explorer: 'https://mantlescan.xyz', l1Oracle: OP_ORACLE },
  { id: 42220, name: 'Celo', symbol: 'CELO', rpc: ['https://forno.celo.org'], explorer: 'https://celoscan.io', l1Oracle: OP_ORACLE },
  { id: 146, name: 'Sonic', symbol: 'S', rpc: ['https://rpc.soniclabs.com', 'https://sonic-rpc.publicnode.com'], explorer: 'https://sonicscan.org' },
  { id: 25, name: 'Cronos', symbol: 'CRO', rpc: ['https://evm.cronos.org', 'https://cronos-evm-rpc.publicnode.com'], explorer: 'https://explorer.cronos.org' },
  { id: 8217, name: 'Kaia', symbol: 'KAIA', rpc: ['https://public-en.node.kaia.io'], explorer: 'https://kaiascan.io' },
  { id: 61, name: 'Ethereum Classic', symbol: 'ETC', rpc: ['https://etc.etcdesktop.com', 'https://ethereum-classic-mainnet.gateway.tatum.io'], explorer: 'https://etc.blockscout.com' },
  { id: 10001, name: 'EthereumPoW', symbol: 'ETHW', rpc: ['https://mainnet.ethereumpow.org'], explorer: '' },
  { id: 11155111, name: 'Sepolia', symbol: 'ETH', rpc: ['https://ethereum-sepolia-rpc.publicnode.com'], explorer: 'https://sepolia.etherscan.io', testnet: true },
  { id: 560048, name: 'Hoodi', symbol: 'ETH', rpc: ['https://ethereum-hoodi-rpc.publicnode.com'], explorer: 'https://hoodi.etherscan.io', testnet: true },
];

/** Validates and normalizes a user-defined network. */
export function normalizeCustomChain({ name, id, symbol, rpc, explorer }) {
  const chainId = Number(String(id ?? '').trim());
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new WalletError('err.chainId');
  const cleanName = String(name ?? '').trim().slice(0, 40);
  const cleanSymbol = String(symbol ?? '').trim().slice(0, 12);
  if (!cleanName || !cleanSymbol) throw new WalletError('err.chainFields');
  const url = String(rpc ?? '').trim();
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new WalletError('err.rpcUrl');
  const exp = String(explorer ?? '').trim().replace(/\/+$/, '');
  if (exp && !/^https?:\/\/[^\s]+$/i.test(exp)) throw new WalletError('err.explorerUrl');
  return { id: chainId, name: cleanName, symbol: cleanSymbol, rpc: url ? [url] : [], explorer: exp, custom: true };
}

export function explorerTxUrl(chain, hash) {
  return chain?.explorer ? `${chain.explorer}/tx/${hash}` : '';
}
