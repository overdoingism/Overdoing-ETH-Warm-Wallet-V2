// Builds the single-file wallet, then deploys test ERC20 / ERC721 / ERC1155 contracts.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ContractFactory, JsonRpcProvider } from 'ethers';
import { CONTRACTS_FILE, RPC, ROOT, account } from './helpers.mjs';

const require = createRequire(import.meta.url);
const artifact = (name) => require(`@openzeppelin/contracts/build/contracts/${name}.json`);

async function waitForNode(provider) {
  for (let i = 0; i < 120; i++) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`no node at ${RPC}`);
}

export default async function globalSetup() {
  execFileSync(process.execPath, ['build.mjs'], { cwd: ROOT, stdio: 'inherit' });
  const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
  await waitForNode(provider);
  const deployer = account(0).connect(provider);
  const owner = account(0).address;

  const deploy = async (name, ...args) => {
    const a = artifact(name);
    const c = await new ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const erc20 = await deploy('ERC20PresetFixedSupply', 'Test Dollar', 'TUSD', 10n ** 24n, owner);
  const erc721 = await deploy('ERC721PresetMinterPauserAutoId', 'Test Art', 'TART', 'https://example.invalid/');
  for (let i = 0; i < 3; i++) await (await erc721.mint(owner)).wait();
  const erc1155 = await deploy('ERC1155PresetMinterPauser', 'https://example.invalid/{id}.json');
  await (await erc1155.mint(owner, 7, 10, '0x')).wait();

  writeFileSync(
    CONTRACTS_FILE,
    JSON.stringify({ erc20: await erc20.getAddress(), erc721: await erc721.getAddress(), erc1155: await erc1155.getAddress() }, null, 2),
  );
}
