import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HDNodeWallet, JsonRpcProvider } from 'ethers';
import { expect } from '@playwright/test';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WALLET_URL = pathToFileURL(join(ROOT, 'dist', 'oeww.html')).href;
export const CONTRACTS_FILE = join(ROOT, 'test', 'e2e', '.contracts.json');
export const RPC = 'http://127.0.0.1:8545';
export const JUNK = 'test test test test test test test test test test test junk';
export const path = (i) => `m/44'/60'/0'/0/${i}`;
export const account = (i) => HDNodeWallet.fromPhrase(JUNK, undefined, path(i));
export const provider = () => new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
export const contracts = () => JSON.parse(readFileSync(CONTRACTS_FILE, 'utf8'));

/** Opens the wallet and fails the test on any page error, CSP violation or unexpected request. */
export async function openWallet(page, { lang = 'zh-TW' } = {}) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/getUserMedia|NotFoundError|NotAllowedError|Requested device/i.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => {
    const url = r.url();
    if (!url.startsWith('file:') && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith(RPC)) problems.push(`request: ${url}`);
  });
  await page.addInitScript((l) => localStorage.setItem('oeww.lang', JSON.stringify(l)), lang);
  await page.goto(WALLET_URL);
  await expect(page.locator('#btnLoad')).not.toBeEmpty();
  return problems;
}

export async function addHardhat(page) {
  await page.locator('#secAdv > summary').click();
  await page.fill('#netName', 'Hardhat');
  await page.fill('#netId', '31337');
  await page.fill('#netSym', 'ETH');
  await page.fill('#netRpc', RPC);
  await page.click('#btnAddNet');
  await expect(page.locator('#chainSel')).toHaveValue('31337');
  await page.locator('#secAdv > summary').click();
}

export async function loadKey(page, text, derivePath) {
  await page.fill('#keyInput', text);
  if (derivePath) await page.fill('#derivePath', derivePath);
  await page.click('#btnLoad');
  await expect(page.locator('#acctView')).toBeVisible();
}

export async function fetchInfo(page) {
  await page.click('#btnInfo');
  await expect(page.locator('#infoBox')).toBeVisible();
}

export const pickAsset = (page, value) => page.locator(`input[name="asset"][value="${value}"] + span`).click();

/** Clicks the main action button and accepts the review dialog. */
export async function signViaForm(page) {
  await page.click('#btnSign');
  await expect(page.locator('#dlgConfirm')).toBeVisible();
  await page.click('#cfOk');
  await expect(page.locator('#secResult')).toBeVisible();
}

export async function broadcastAndWait(page) {
  await page.click('#btnBroadcast');
  await expect(page.locator('#bcastStatus')).toHaveClass(/\bok\b/, { timeout: 60_000 });
}

/** Feeds text through the scanner dialog's paste box (what a QR scan would deliver). */
export async function scanText(page, text) {
  await page.click('#btnScan');
  await expect(page.locator('#dlgScan')).toBeVisible();
  await page.fill('#scanText', text);
  await page.click('#btnScanUse');
}
