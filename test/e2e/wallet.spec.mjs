import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { Contract, Wallet, formatEther, parseEther, verifyMessage } from 'ethers';
import encodeQR from 'qr';
import {
  JUNK,
  RPC,
  WALLET_URL,
  account,
  addHardhat,
  broadcastAndWait,
  contracts,
  fetchInfo,
  loadKey,
  openWallet,
  path,
  pickAsset,
  provider,
  scanText,
  signViaForm,
} from './helpers.mjs';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const ERC721_ABI = ['function ownerOf(uint256) view returns (address)'];
const ERC1155_ABI = ['function balanceOf(address,uint256) view returns (uint256)'];

test('loads with no network traffic, no errors, and switches language', async ({ page }) => {
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  const problems = await openWallet(page);
  await page.waitForTimeout(1500);
  expect(seen.filter((u) => !u.startsWith('file:') && !u.startsWith('data:'))).toEqual([]);
  await expect(page.locator('#btnLoad')).toHaveText('載入');
  await page.click('#btnLang');
  await expect(page.locator('#btnLoad')).toHaveText('Load');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(problems).toEqual([]);
});

test('hot wallet: mnemonic account sends the native coin', async ({ page }) => {
  const problems = await openWallet(page);
  const p = provider();
  const to = account(11).address;
  const before = await p.getBalance(to);
  await addHardhat(page);
  await loadKey(page, JUNK, path(1));
  await expect(page.locator('#acctAddr')).toHaveText(account(1).address);
  await expect(page.locator('#acctBadge')).toHaveClass(/signer/);
  await fetchInfo(page);
  await expect(page.locator('#nonce')).not.toHaveValue('');
  await page.fill('#toAddr', to);
  await expect(page.locator('#toHint')).toHaveClass(/ok/);
  await page.fill('#amount', '1.5');
  await signViaForm(page);
  await expect(page.locator('#resultQr')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await broadcastAndWait(page);
  expect((await p.getBalance(to)) - before).toBe(parseEther('1.5'));
  expect(problems).toEqual([]);
});

test('hot wallet: ERC20, ERC721 and ERC1155 transfers with a raw private key', async ({ page }) => {
  const problems = await openWallet(page);
  const p = provider();
  const c = contracts();
  const to = account(12).address;
  await addHardhat(page);
  await loadKey(page, account(0).privateKey.slice(2));
  await fetchInfo(page);

  // ERC20
  await pickAsset(page, 'erc20');
  await page.fill('#tokenAddr', c.erc20);
  await page.click('#btnTokenInfo');
  await expect(page.locator('#tokenDec')).toHaveValue('18');
  await expect(page.locator('#tokenSym')).toHaveValue('TUSD');
  await expect(page.locator('#tokenStatus')).toContainText('TUSD');
  await page.fill('#toAddr', to);
  await page.fill('#amount', '12.34');
  await signViaForm(page);
  await broadcastAndWait(page);
  expect(await new Contract(c.erc20, ERC20_ABI, p).balanceOf(to)).toBe(parseEther('12.34'));

  // ERC721 (token #1)
  await fetchInfo(page);
  await pickAsset(page, 'nft');
  await page.fill('#nftAddr', c.erc721);
  await page.fill('#nftId', '1');
  await page.click('#btnNftInfo');
  await expect(page.locator('#nftStd')).toHaveValue('erc721');
  await expect(page.locator('#nftStatus')).toHaveClass(/ok/);
  await expect(page.locator('#amountRow')).toBeHidden();
  await signViaForm(page);
  await broadcastAndWait(page);
  expect(await new Contract(c.erc721, ERC721_ABI, p).ownerOf(1)).toBe(to);

  // ERC1155 (id 7 × 3)
  await fetchInfo(page);
  await page.fill('#nftAddr', c.erc1155);
  await page.fill('#nftId', '7');
  await page.click('#btnNftInfo');
  await expect(page.locator('#nftStd')).toHaveValue('erc1155');
  await page.fill('#amount', '3');
  await signViaForm(page);
  await broadcastAndWait(page);
  expect(await new Contract(c.erc1155, ERC1155_ABI, p).balanceOf(to, 7)).toBe(3n);
  expect(problems).toEqual([]);
});

test('air-gapped: watch-only request → offline signature → broadcast', async ({ browser }) => {
  const p = provider();
  const signer = account(3);
  const to = account(13).address;
  const before = await p.getBalance(to);

  const onlineCtx = await browser.newContext();
  const offlineCtx = await browser.newContext();
  const online = await onlineCtx.newPage();
  const offline = await offlineCtx.newPage();
  const onlineProblems = await openWallet(online);
  const offlineProblems = await openWallet(offline);
  await offlineCtx.setOffline(true);
  const offlineRequests = [];
  offline.on('request', (r) => offlineRequests.push(r.url()));

  // Online device only knows the address.
  await addHardhat(online);
  await loadKey(online, signer.address);
  await expect(online.locator('#acctBadge')).toHaveClass(/watch/);
  await fetchInfo(online);
  await online.fill('#toAddr', to);
  await online.fill('#amount', '0.75');
  await signViaForm(online);
  const request = await online.locator('#resultText').inputValue();
  expect(JSON.parse(request)).toMatchObject({ oeww: 'tx', chainId: 31337, from: signer.address, to, amount: '0.75' });

  // Offline device holds the mnemonic; the unknown chain is added from the request itself.
  await loadKey(offline, JUNK, path(3));
  await scanText(offline, request);
  await expect(offline.locator('#dlgConfirm')).toBeVisible();
  await offline.click('#cfOk'); // add "Hardhat" network
  await expect(offline.locator('#dlgConfirm')).toBeVisible();
  await expect(offline.locator('#cfRows')).toContainText('0.75');
  await offline.click('#cfOk'); // sign
  await expect(offline.locator('#secResult')).toBeVisible();
  const signed = await offline.locator('#resultText').inputValue();
  expect(signed).toMatch(/^0x02/);
  expect(offlineRequests.filter((u) => !u.startsWith('data:'))).toEqual([]);

  // Back online: scan the signed transaction and broadcast it.
  await scanText(online, signed.toUpperCase()); // the QR carries upper-case hex
  await expect(online.locator('#resultRows')).toContainText(signer.address);
  await broadcastAndWait(online);
  expect((await p.getBalance(to)) - before).toBe(parseEther('0.75'));
  expect([...onlineProblems, ...offlineProblems]).toEqual([]);
  await onlineCtx.close();
  await offlineCtx.close();
});

test('air-gapped message signing and verification', async ({ browser }) => {
  const signer = account(4);
  const message = 'I own this address 我擁有此地址 2026';
  const online = await (await browser.newContext()).newPage();
  const offline = await (await browser.newContext()).newPage();
  await openWallet(online);
  await openWallet(offline);

  await loadKey(online, signer.address);
  await online.locator('#secAdv > summary').click();
  await online.fill('#msgInput', message);
  await online.click('#btnSignMsg');
  await expect(online.locator('#resultText')).toHaveValue(/"oeww":"msg"/);
  const req = await online.locator('#resultText').inputValue();

  await loadKey(offline, JUNK, path(4));
  await scanText(offline, req);
  await expect(offline.locator('#dlgConfirm')).toBeVisible();
  await offline.click('#cfOk');
  await expect(offline.locator('#resultText')).toHaveValue(/"sig"/);
  const sigJson = await offline.locator('#resultText').inputValue();
  const sig = JSON.parse(sigJson);
  expect(sig).toMatchObject({ address: signer.address, msg: message, version: '2' });
  expect(verifyMessage(message, sig.sig)).toBe(signer.address);

  await scanText(online, sigJson);
  await expect(online.locator('#resultRows dd.good')).toBeVisible();
  const tampered = JSON.stringify({ ...sig, msg: message + '!' });
  await scanText(online, tampered);
  await expect(online.locator('#resultRows dd.bad')).toBeVisible();
});

test('keystore export/import and the encrypted browser vault', async ({ page }) => {
  const problems = await openWallet(page);
  const acct = account(5);
  const pw = 'correct horse battery';
  await loadKey(page, acct.privateKey);

  // Export → a standard keystore that ethers can open.
  await page.click('#btnExportKs');
  await page.fill('#pw1', pw);
  await page.fill('#pw2', pw);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#pwOk')]);
  expect(download.suggestedFilename()).toMatch(/^UTC--.*--[0-9a-f]{40}\.json$/);
  const ksPath = await download.path();
  expect((await Wallet.fromEncryptedJson(readFileSync(ksPath, 'utf8'), pw)).address).toBe(acct.address);

  // Import it again.
  await page.click('#btnLogout');
  await page.setInputFiles('#ksFile', ksPath);
  await expect(page.locator('#dlgPw')).toBeVisible();
  await page.fill('#pw1', 'wrong password');
  await page.click('#pwOk');
  await expect(page.locator('#dlgAlert')).toBeVisible();
  await page.click('#dlgAlert [data-close]');
  await page.setInputFiles('#ksFile', ksPath);
  await page.fill('#pw1', pw);
  await page.click('#pwOk');
  await expect(page.locator('#acctAddr')).toHaveText(acct.address);

  // Vault: the risk acknowledgement is required.
  await page.click('#btnSaveVault');
  await page.fill('#pwName', 'Daily');
  await page.fill('#pw1', pw);
  await page.fill('#pw2', pw);
  await page.click('#pwOk');
  await expect(page.locator('#pwErr')).not.toBeEmpty();
  await page.check('#pwAck');
  await page.click('#pwOk');
  await expect(page.locator('#toast')).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('oeww.vault.v1'));
  expect(stored).not.toContain(acct.privateKey.slice(2));

  await page.click('#btnLogout');
  await page.click('#btnVault');
  await expect(page.locator('#vaultList li')).toHaveCount(1);
  await page.locator('#vaultList li .btn.primary').click();
  await page.fill('#pw1', pw);
  await page.click('#pwOk');
  await expect(page.locator('#acctAddr')).toHaveText(acct.address);
  await expect(page.locator('#acctBadge')).toHaveClass(/signer/);

  await page.click('#btnLogout'); // saved wallets are managed from the login screen
  await page.click('#btnVault');
  await page.locator('#vaultList li .btn:not(.primary)').click();
  await page.click('#cfOk');
  await page.click('#btnVault');
  await expect(page.locator('#vaultList li')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('"max" leaves exactly enough for the fee', async ({ page }) => {
  const problems = await openWallet(page);
  const p = provider();
  // A fresh account per run, so the test does not depend on what earlier runs spent.
  const from = Wallet.createRandom();
  await (await account(0).connect(p).sendTransaction({ to: from.address, value: parseEther('2') })).wait();
  await addHardhat(page);
  await loadKey(page, from.privateKey);
  await fetchInfo(page);
  await page.fill('#toAddr', account(16).address);
  await page.click('#btnMax');
  await expect(page.locator('#amount')).not.toHaveValue('');
  await signViaForm(page);
  await broadcastAndWait(page);
  const left = await p.getBalance(from.address);
  expect(left).toBeGreaterThanOrEqual(0n);
  expect(Number(formatEther(left))).toBeLessThan(0.001);
  expect(problems).toEqual([]);
});

test('input checks: bad mnemonic checksum, bad recipient checksum', async ({ page }) => {
  const problems = await openWallet(page);
  await page.fill('#keyInput', JUNK.replace('test junk', 'junk test'));
  await page.click('#btnLoad');
  await expect(page.locator('#dlgConfirm')).toBeVisible();
  await page.locator('#dlgConfirm [data-close=""]').click();
  await expect(page.locator('#acctView')).toBeHidden();

  await loadKey(page, account(7).privateKey);
  const good = account(8).address;
  const bad = good.slice(0, 2) + [...good.slice(2)].map((ch) => (/[a-f]/.test(ch) ? ch.toUpperCase() : /[A-F]/.test(ch) ? ch.toLowerCase() : ch)).join('');
  await page.fill('#toAddr', bad);
  await expect(page.locator('#toHint')).toHaveClass(/bad/);
  await page.fill('#amount', '1');
  await page.fill('#nonce', '0');
  await page.fill('#maxFee', '2');
  await page.fill('#tipFee', '1');
  await page.click('#btnSign');
  await expect(page.locator('#dlgAlert')).toBeVisible();
  await expect(page.locator('#dlgConfirm')).toBeHidden();
  expect(problems).toEqual([]);
});

test('token safety: contract fields reset on network change; missing contract is flagged', async ({ page }) => {
  const problems = await openWallet(page);
  await loadKey(page, account(10).privateKey);
  await pickAsset(page, 'erc20');
  await page.selectOption('#tokenSel', { index: 1 }); // a built-in Ethereum token
  await expect(page.locator('#tokenAddr')).not.toHaveValue('');
  await page.selectOption('#chainSel', '137');
  await expect(page.locator('#tokenAddr')).toHaveValue('');

  await addHardhat(page);
  await fetchInfo(page);
  await page.fill('#tokenAddr', account(15).address); // an EOA, not a token
  await page.fill('#tokenSym', 'FAKE');
  await page.fill('#tokenDec', '18');
  await page.fill('#toAddr', account(14).address);
  await page.fill('#amount', '1');
  await page.click('#btnSign');
  await expect(page.locator('#dlgConfirm')).toBeVisible();
  await expect(page.locator('#cfWarn li.danger')).toHaveCount(1);
  await page.locator('#dlgConfirm [data-close=""]').click();
  expect(problems).toEqual([]);
});

/** A one-frame Y4M video showing `text` as a QR code, for Chromium's fake camera. */
function qrVideo(text) {
  const W = 640;
  const H = 480;
  const matrix = encodeQR(text, 'raw', { border: 4 });
  const scale = Math.floor(Math.min(W, H) * 0.8 / matrix.length);
  const ox = Math.floor((W - matrix.length * scale) / 2);
  const oy = Math.floor((H - matrix.length * scale) / 2);
  const y = Buffer.alloc(W * H, 235);
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (!matrix[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) y.fill(16, (oy + r * scale + dy) * W + ox + c * scale, (oy + r * scale + dy) * W + ox + (c + 1) * scale);
    }
  }
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]);
}

test('scans a QR code from the camera', async () => {
  const address = account(9).address;
  const video = join(tmpdir(), `oeww-qr-${process.pid}.y4m`);
  writeFileSync(video, qrVideo(address));
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  try {
    const page = await browser.newPage();
    const problems = await openWallet(page);
    await page.click('#btnScan');
    await expect(page.locator('#acctView')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#acctAddr')).toHaveText(address);
    await expect(page.locator('#dlgScan')).toBeHidden();
    expect(problems).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('RPC for the wrong chain is refused', async ({ page }) => {
  await openWallet(page);
  await loadKey(page, account(2).address);
  await page.fill('#rpcUrl', RPC); // Ethereum selected, but this node is chain 31337
  await page.locator('#rpcUrl').dispatchEvent('change');
  await page.click('#btnInfo');
  await expect(page.locator('#dlgAlert')).toBeVisible();
  await expect(page.locator('#alMsg')).toContainText('31337');
});

test('the built file is self-contained', async () => {
  const html = readFileSync(new URL(WALLET_URL), 'utf8');
  expect(html).not.toMatch(/<script[^>]+src=/i);
  expect(html).not.toMatch(/<link[^>]+href=/i);
  expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'; script-src 'sha256-/);
});
