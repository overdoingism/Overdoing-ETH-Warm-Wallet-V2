// Well-known tokens, cross-checked against the Uniswap default token list and on-chain
// symbol()/decimals() (scripts/verify-tokens.mjs). An offline signer cannot query a token,
// so this list is what lets it confirm that "100 USDT" really means 100 × 10^6 base units.
const T = (symbol, address, decimals) => ({ symbol, address, decimals });

export const TOKENS = {
  1: [
    T('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
    T('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
    T('DAI', '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18),
    T('WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18),
    T('WBTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8),
    T('LINK', '0x514910771AF9Ca656af840dff83E8264EcF986CA', 18),
    T('UNI', '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 18),
  ],
  42161: [
    T('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
    T('USDC.e', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6),
    T('USDT0', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
    T('DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18),
    T('WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18),
    T('ARB', '0x912CE59144191C1204E64559FE8253a0e49E6548', 18),
  ],
  10: [
    T('USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
    T('USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
    T('DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18),
    T('WETH', '0x4200000000000000000000000000000000000006', 18),
    T('OP', '0x4200000000000000000000000000000000000042', 18),
  ],
  8453: [
    T('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
    T('DAI', '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 18),
    T('WETH', '0x4200000000000000000000000000000000000006', 18),
  ],
  137: [
    T('USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6),
    T('USDC.e', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6),
    T('USDT0', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
    T('DAI', '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 18),
    T('WETH', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 18),
  ],
  56: [
    T('USDT', '0x55d398326f99059fF775485246999027B3197955', 18),
    T('USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18),
    T('WBNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 18),
  ],
  43114: [
    T('USDC', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6),
    T('USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6),
    T('WAVAX', '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', 18),
  ],
  130: [
    T('USDC', '0x078D782b760474a361dDA0AF3839290b0EF57AD6', 6),
    T('WETH', '0x4200000000000000000000000000000000000006', 18),
  ],
  42220: [
    T('USDC', '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', 6),
    T('USDT', '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', 6),
  ],
};

export const tokensFor = (chainId) => TOKENS[chainId] ?? [];

export function findToken(chainId, address) {
  if (!address) return undefined;
  const a = address.toLowerCase();
  return tokensFor(chainId).find((t) => t.address.toLowerCase() === a);
}
