// Read-only smoke test against the real public RPCs (needs internet). Off by default:
//   OEWW_PUBLIC_RPC=1 npx playwright test public-rpc
import { expect, test } from '@playwright/test';
import { WALLET_URL } from './helpers.mjs';

test.skip(!process.env.OEWW_PUBLIC_RPC, 'set OEWW_PUBLIC_RPC=1 to run');

const WATCH = '0x7cE987d1C417DBb86CfE6f9Ac6cfEDF7554853AF';
const CHAIN_IDS = ['1', '42161', '10', '8453', '137', '56', '43114', '100', '59144', '534352', '324', '130', '5000', '42220', '146', '25', '8217', '61', '10001', '11155111', '560048'];

test('every built-in network answers from a file:// page', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(WALLET_URL);
  await page.fill('#keyInput', WATCH);
  await page.click('#btnLoad');
  const failures = [];
  for (const id of CHAIN_IDS) {
    await page.selectOption('#chainSel', id);
    await page.click('#btnInfo');
    const err = page.locator('#dlgAlert');
    await expect(page.locator('#infoBox:not([hidden]), #dlgAlert[open]')).toBeVisible({ timeout: 40_000 });
    if (await err.isVisible()) {
      failures.push(`${id}: ${await page.locator('#alMsg').textContent()}`);
      await page.click('#dlgAlert [data-close]');
    } else {
      console.log(id.padEnd(9), (await page.locator('#infoFee').textContent())?.trim());
    }
  }
  expect(failures).toEqual([]);
});

test('USDT lookup on Ethereum', async ({ page }) => {
  await page.goto(WALLET_URL);
  await page.fill('#keyInput', WATCH);
  await page.click('#btnLoad');
  await page.locator('input[name="asset"][value="erc20"] + span').click();
  await page.fill('#tokenAddr', '0xdac17f958d2ee523a2206206994597c13d831ec7');
  await page.click('#btnTokenInfo');
  await expect(page.locator('#tokenDec')).toHaveValue('6');
  await expect(page.locator('#tokenStatus')).toHaveClass(/ok/);
});
