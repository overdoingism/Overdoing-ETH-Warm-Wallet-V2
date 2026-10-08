// Maintenance check: every built-in token must report the expected decimals on-chain,
// and every built-in RPC must answer with the right chain ID.
import { CHAINS } from '../src/core/chains.js';
import { TOKENS } from '../src/core/tokens.js';
import { createRpc, getChainId, getTokenInfo } from '../src/core/rpc.js';

let failures = 0;
for (const chain of CHAINS) {
  for (const url of chain.rpc) {
    try {
      const id = await getChainId(createRpc(url, { timeoutMs: 15000 }));
      if (id !== chain.id) throw new Error(`chainId ${id}`);
      console.log(`ok   rpc  ${chain.name.padEnd(18)} ${url}`);
    } catch (e) {
      failures++;
      console.log(`FAIL rpc  ${chain.name.padEnd(18)} ${url}  ${e.key ?? ''} ${e.message}`);
    }
  }
  const tokens = TOKENS[chain.id] ?? [];
  if (!tokens.length) continue;
  const rpc = createRpc(chain.rpc[0], { timeoutMs: 20000 });
  for (const t of tokens) {
    try {
      const info = await getTokenInfo(rpc, t.address);
      const ok = info.decimals === t.decimals;
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} token ${chain.name.padEnd(18)} ${t.symbol.padEnd(7)} on-chain ${info.symbol}/${info.decimals}`);
    } catch (e) {
      failures++;
      console.log(`FAIL token ${chain.name.padEnd(18)} ${t.symbol.padEnd(7)} ${e.key ?? ''} ${e.message}`);
    }
  }
}
console.log(failures ? `\n${failures} problem(s)` : '\nall good');
process.exitCode = failures ? 1 : 0;
