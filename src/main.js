import { CHAINS, explorerTxUrl, normalizeCustomChain } from './core/chains.js';
import { findToken, tokensFor } from './core/tokens.js';
import { DEFAULT_PATH, classifyInput, deriveFromMnemonic, inspectMnemonic, parseAddress, parsePrivateKey } from './core/keys.js';
import { decryptKeystore, encryptKeystore, keystoreFileName, parseKeystore } from './core/keystore.js';
import { createVault } from './core/vault.js';
import { DEFAULT_GAS, buildTransaction, describeTransaction, maxCost, parseSignedTransaction, requireAddress, signTransaction } from './core/tx.js';
import { decodePayload, encodeMsgRequest, encodeSignature, encodeTxRequest, signedTxForQr } from './core/payload.js';
import {
  RpcError,
  assertChain,
  createRpc,
  estimateGas,
  getAccountInfo,
  detectL1Oracle,
  getL1Fee,
  getNftInfo,
  getRevertReason,
  getTokenInfo,
  sendRawTransaction,
  waitForReceipt,
} from './core/rpc.js';
import { isHexMessage, recoverSigner, signMessage } from './core/message.js';
import { formatAmount, formatGwei, parseGwei, parseInteger } from './core/amount.js';
import { WalletError } from './core/errors.js';
import { applyI18n, getLang, initLang, setLang, t } from './i18n.js';
import { decodeImageFile, qrDataUrl, startScanner } from './ui/qr.js';
import { $, bullet, copyText, download, para, radio, setRadio, show, toast, val } from './ui/dom.js';
import { action, alertError, confirmDialog, errorText, fillRows, initDialogs, openDialog, passwordDialog, withBusy } from './ui/dialogs.js';

// ---------------------------------------------------------------- helpers
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '');
const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Rounds wei up to 4 significant digits and prints it in gwei (fees: rounding up is safe). */
function gweiUp(wei) {
  const w = BigInt(wei);
  const digits = w.toString().length;
  if (digits <= 4) return formatGwei(w);
  const unit = 10n ** BigInt(digits - 4);
  return formatGwei(((w + unit - 1n) / unit) * unit);
}

// Non-secret preferences (language, network, RPC choices). Private keys never go here.
const safeStorage = (() => {
  try {
    const s = window.localStorage;
    s.getItem('oeww.probe');
    return s;
  } catch {
    const fail = () => {
      throw new Error('storage unavailable');
    };
    return { getItem: fail, setItem: fail };
  }
})();
const store = {
  get(key, fallback) {
    try {
      const v = safeStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      safeStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private mode / blocked storage: preferences just are not remembered
    }
  },
};
const vault = createVault(safeStorage);

// ---------------------------------------------------------------- state
const state = {
  account: null, // { address, privateKey?, source, mnemonic?, passphrase?, path? }
  info: null, // last getAccountInfo() for this account + network
  token: null, // last token query { chainId, address, symbol, decimals, balance }
  nft: null, // last NFT query { chainId, address, tokenId, standard, name, holder, owned, balance }
  result: null, // what the result card shows
  gasTouched: false,
  watchId: 0,
};

// ---------------------------------------------------------------- networks
let chains = [];
const getChain = (id) => chains.find((c) => c.id === Number(id));
const currentChain = () => getChain($('chainSel').value) ?? chains[0];

function loadChains() {
  const custom = store.get('oeww.customChains', []).flatMap((c) => {
    try {
      const n = normalizeCustomChain({ ...c, rpc: c.rpc?.[0] ?? '' });
      return CHAINS.some((b) => b.id === n.id) ? [] : [n];
    } catch {
      return [];
    }
  });
  chains = [...CHAINS, ...custom];
}

function renderChainSelect(selectedId) {
  const sel = $('chainSel');
  const group = (label, list) => {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const c of list) g.append(new Option(`${c.name} · ${c.symbol}`, String(c.id)));
    return g;
  };
  const main = chains.filter((c) => !c.testnet && !c.custom);
  const test = chains.filter((c) => c.testnet);
  const custom = chains.filter((c) => c.custom);
  sel.replaceChildren(group(t('net.mainnets'), main), group(t('net.testnets'), test));
  if (custom.length) sel.append(group(t('net.custom'), custom));
  sel.value = String(getChain(selectedId) ? selectedId : 1);
}

function rpcFor(chain) {
  return store.get('oeww.rpc', {})[chain.id] || chain.rpc[0] || '';
}

function selectChain(id) {
  if (Number($('chainSel').value) === Number(id)) return;
  $('chainSel').value = String(id);
  onChainChange();
}

function onChainChange() {
  const chain = currentChain();
  $('rpcUrl').value = rpcFor(chain);
  $('rpcList').replaceChildren(...chain.rpc.map((u) => new Option(u, u)));
  store.set('oeww.chain', chain.id);
  // A contract address from another network must never be reused by accident.
  for (const id of ['tokenAddr', 'tokenSym', 'tokenDec', 'nftAddr', 'nftId']) $(id).value = '';
  state.info = null;
  state.token = null;
  state.nft = null;
  show('infoBox', false);
  show('btnDelNet', !!chain.custom);
  renderTokenSelect();
  renderNftStatus();
  updateAssetUi();
}

function onRpcChange() {
  const chain = currentChain();
  const map = store.get('oeww.rpc', {});
  const v = val('rpcUrl');
  if (!v || v === chain.rpc[0]) delete map[chain.id];
  else map[chain.id] = v;
  store.set('oeww.rpc', map);
  state.info = null;
  show('infoBox', false);
}

function rpc() {
  const url = val('rpcUrl');
  if (!url) throw new WalletError('err.noRpc');
  return createRpc(url);
}

function addCustomChain(raw) {
  const c = normalizeCustomChain(raw);
  if (CHAINS.some((b) => b.id === c.id)) throw new WalletError('err.chainBuiltin', { id: c.id });
  const list = store.get('oeww.customChains', []).filter((x) => x.id !== c.id);
  list.push(c);
  store.set('oeww.customChains', list);
  loadChains();
  renderChainSelect(c.id);
  onChainChange();
  return getChain(c.id);
}

// ---------------------------------------------------------------- account
function requireAccount() {
  if (!state.account) throw new WalletError('err.noAccount');
  return state.account;
}

/** Info is only trusted for the account and network it was fetched for. */
function freshInfo() {
  const i = state.info;
  return i && i.chainId === currentChain().id && sameAddr(i.address, state.account?.address) ? i : null;
}

/**
 * Network, RPC and account a lookup was started for. A reply that arrives after any of them
 * changed is dropped, so it can never fill the form for a different network or account.
 */
const queryContext = () => `${currentChain().id}|${val('rpcUrl')}|${state.account?.address ?? ''}`;

/** Built-in L2s name their L1 fee oracle; custom networks get theirs detected by "Fetch info". */
const l1Oracle = () => currentChain().l1Oracle ?? freshInfo()?.l1Oracle;

function setAccount(acc) {
  state.account = acc;
  state.info = null;
  state.token = null;
  state.nft = null;
  $('keyInput').value = '';
  $('passphrase').value = '';
  show('mnemonicOpts', false);
  show('acctInput', false);
  show('acctView', true);
  show('acctPathRow', acc.source === 'mnemonic');
  $('acctPath').value = acc.path ?? '';
  show('infoBox', false);
  clearResult();
  renderAccount();
  renderTokenStatus();
  renderNftStatus();
  updateToHint();
}

function renderAccount() {
  const acc = state.account;
  const signer = !!acc?.privateKey;
  if (acc) {
    $('acctAddr').textContent = acc.address;
    $('acctBadge').textContent = t(signer ? 'acct.signer' : 'acct.watch');
    $('acctBadge').className = `badge ${signer ? 'signer' : 'watch'}`;
  }
  show('btnSaveVault', signer);
  show('btnExportKs', signer);
  $('btnSign').textContent = acc && !signer ? t('send.makeRequest') : t('send.sign');
  $('btnSignMsg').textContent = acc && !signer ? t('msg.makeRequest') : t('msg.sign');
}

function logout() {
  state.account = null;
  state.info = null;
  state.token = null;
  state.nft = null;
  state.watchId++;
  show('acctInput', true);
  show('acctView', false);
  show('infoBox', false);
  $('keyInput').value = '';
  $('acctAddr').textContent = '';
  clearResult();
  renderAccount();
  renderTokenStatus();
  renderNftStatus();
}

async function loadFromInput() {
  const text = $('keyInput').value;
  switch (classifyInput(text)) {
    case 'empty':
      throw new WalletError('err.inputEmpty');
    case 'privateKey':
      return setAccount({ ...parsePrivateKey(text), source: 'privateKey' });
    case 'address': {
      const a = parseAddress(text);
      if (a.checksum === 'invalid') throw new WalletError('err.addressChecksum', { field: 'address' });
      return setAccount({ address: a.address, source: 'address' });
    }
    case 'keystore':
      return loadKeystoreText(text);
    default:
      return loadMnemonic(text);
  }
}

async function loadMnemonic(text) {
  const m = inspectMnemonic(text);
  if (m.status === 'badLength') throw new WalletError('err.mnemonicLength', { n: m.wordCount });
  if (m.status !== 'ok') {
    const warning =
      m.status === 'badChecksum' ? t('mn.badChecksum') : t('mn.unknownWords', { words: m.unknownWords.slice(0, 6).join(', ') });
    const go = await confirmDialog({
      title: t('mn.title'),
      warnings: [{ text: warning, danger: true }, { text: t('mn.explain') }],
      ok: t('mn.useAnyway'),
    });
    if (!go) return;
  }
  const passphrase = $('passphrase').value;
  const d = deriveFromMnemonic(m.phrase, passphrase, $('derivePath').value);
  setAccount({ ...d, source: 'mnemonic', mnemonic: m.phrase, passphrase });
}

function applyPath() {
  const acc = requireAccount();
  const d = deriveFromMnemonic(acc.mnemonic, acc.passphrase, $('acctPath').value);
  setAccount({ ...acc, ...d });
  toast(t('acct.pathApplied'));
}

async function loadKeystoreText(text) {
  const parsed = parseKeystore(text);
  const intro = parsed.address ? [para(t('ks.forAddress', { address: parsed.address }))] : [];
  const r = await passwordDialog({ title: t('ks.unlockTitle'), intro });
  if (!r) return;
  const acc = await withBusy(t('busy.decrypt'), (onProgress) => decryptKeystore(text, r.password, { onProgress }));
  setAccount({ ...acc, source: 'keystore' });
}

async function saveToVault() {
  const acc = requireAccount();
  const intro = [para(t('vault.riskIntro')), bullet([t('vault.risk1'), t('vault.risk2'), t('vault.risk3'), t('vault.risk4')])];
  if (acc.source === 'mnemonic') intro.push(para(t('vault.mnemonicNote', { path: acc.path })));
  const r = await passwordDialog({ title: t('vault.saveTitle'), intro, confirm: true, name: '', ack: true, minLength: 8 });
  if (!r) return;
  await withBusy(t('busy.encrypt'), (onProgress) => vault.add(r.name || short(acc.address), acc.privateKey, r.password, { onProgress }));
  toast(t('vault.saved'));
}

function renderVaultList() {
  const entries = vault.list();
  show('vaultEmpty', entries.length === 0);
  $('vaultList').replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = e.name;
      const addr = document.createElement('code');
      addr.className = 'addr';
      addr.textContent = e.address;
      const when = document.createElement('span');
      when.className = 'hint';
      when.textContent = t('vault.created', { date: new Date(e.created).toLocaleString() });
      const row = document.createElement('div');
      row.className = 'row';
      const open = document.createElement('button');
      open.className = 'btn small primary';
      open.type = 'button';
      open.textContent = t('vault.open');
      open.onclick = () => unlockVaultEntry(e).catch(alertError);
      const del = document.createElement('button');
      del.className = 'btn small';
      del.type = 'button';
      del.textContent = t('vault.delete');
      del.onclick = () => deleteVaultEntry(e).catch(alertError);
      row.append(open, del);
      li.append(name, addr, when, row);
      return li;
    }),
  );
}

async function openVault() {
  renderVaultList();
  await openDialog($('dlgVault'));
}

async function unlockVaultEntry(e) {
  $('dlgVault').close();
  const r = await passwordDialog({ title: t('vault.unlockTitle', { name: e.name }), intro: [para(e.address)] });
  if (!r) return;
  const acc = await withBusy(t('busy.decrypt'), (onProgress) => vault.unlock(e.id, r.password, { onProgress }));
  setAccount({ ...acc, source: 'vault' });
}

async function deleteVaultEntry(e) {
  $('dlgVault').close();
  const ok = await confirmDialog({
    title: t('vault.deleteTitle'),
    rows: [[t('pw.name'), e.name], [t('rv.address'), e.address, 'mono']],
    warnings: [{ text: t('vault.deleteWarn'), danger: true }],
    ok: t('vault.delete'),
  });
  if (!ok) return;
  vault.remove(e.id);
  toast(t('vault.deleted'));
}

async function exportKeystore() {
  const acc = requireAccount();
  const intro = [para(t('ks.exportIntro'))];
  if (acc.source === 'mnemonic') intro.push(para(t('vault.mnemonicNote', { path: acc.path })));
  const r = await passwordDialog({ title: t('ks.exportTitle'), intro, confirm: true, minLength: 8 });
  if (!r) return;
  const ks = await withBusy(t('busy.encrypt'), (onProgress) => encryptKeystore(acc.privateKey, r.password, { onProgress }));
  download(keystoreFileName(acc.address), JSON.stringify(ks));
}

function showAddressQr() {
  const acc = requireAccount();
  $('qrTitle').textContent = t('acct.addrQr');
  $('qrImg').src = qrDataUrl(acc.address);
  $('qrText').textContent = acc.address;
  $('qrHint').textContent = t('acct.addrQrHint');
  openDialog($('dlgQr'));
}

// ---------------------------------------------------------------- network info
async function fetchInfo() {
  const acc = requireAccount();
  const chain = currentChain();
  const context = queryContext();
  const client = rpc();
  const info = await getAccountInfo(client, acc.address, chain.id);
  // A custom network may be an L2 that charges an extra L1 data fee.
  if (chain.custom && !chain.l1Oracle) info.l1Oracle = await detectL1Oracle(client).catch(() => undefined);
  if (queryContext() !== context) return;
  state.info = { ...info, fetchedAt: new Date() };
  renderInfo();
  $('nonce').value = String(info.nonce);
  if (info.fees.supports1559) {
    setRadio('feeType', '1559');
    $('maxFee').value = gweiUp(info.fees.maxFee);
    $('tipFee').value = gweiUp(info.fees.tip);
  } else {
    setRadio('feeType', 'legacy');
    $('gasPrice').value = gweiUp(info.fees.gasPrice);
  }
  updateFeeUi();
  const asset = currentAsset();
  if (asset === 'erc20' && parseAddress(val('tokenAddr'))) await queryToken().catch(() => {});
  if ((asset === 'erc721' || asset === 'erc1155') && parseAddress(val('nftAddr')) && val('nftId')) await queryNft().catch(() => {});
}

function renderInfo() {
  const i = freshInfo();
  if (!i) return show('infoBox', false);
  const chain = currentChain();
  $('infoBlock').textContent = `#${i.blockNumber} · ${i.fetchedAt.toLocaleTimeString()}`;
  $('infoBal').textContent = `${formatAmount(i.balance, 18)} ${chain.symbol}`;
  $('infoNonce').textContent = String(i.nonce);
  $('infoFee').textContent = i.fees.supports1559
    ? t('net.fee1559', { base: gweiUp(i.fees.baseFee), tip: gweiUp(i.fees.tip) })
    : t('net.feeLegacy', { price: gweiUp(i.fees.gasPrice) });
  show('infoBox', true);
}

// ---------------------------------------------------------------- send form
function currentAsset() {
  const a = radio('asset');
  return a === 'nft' ? $('nftStd').value : a;
}

function updateAssetUi() {
  const a = radio('asset');
  const asset = currentAsset();
  const chain = currentChain();
  $('assetNativeLabel').textContent = chain.symbol;
  show('tokenBox', a === 'erc20');
  show('nftBox', a === 'nft');
  show('amountRow', asset !== 'erc721');
  $('amountUnit').textContent = asset === 'native' ? chain.symbol : asset === 'erc20' ? val('tokenSym') : '';
  if (!state.gasTouched) $('gasLimit').value = String(DEFAULT_GAS[asset]);
  updateFeeHint();
}

function renderTokenSelect() {
  const chain = currentChain();
  const known = findToken(chain.id, val('tokenAddr'));
  $('tokenSel').replaceChildren(
    new Option(t('send.tokenOther'), ''),
    ...tokensFor(chain.id).map((tk) => new Option(`${tk.symbol} · ${short(tk.address)}`, tk.address)),
  );
  $('tokenSel').value = known?.address ?? '';
  renderTokenStatus();
}

function onTokenSelect() {
  const known = findToken(currentChain().id, $('tokenSel').value);
  state.token = null;
  if (known) {
    $('tokenAddr').value = known.address;
    $('tokenSym').value = known.symbol;
    $('tokenDec').value = String(known.decimals);
  } else {
    $('tokenAddr').value = '';
    $('tokenSym').value = '';
    $('tokenDec').value = '';
  }
  renderTokenStatus();
  updateAssetUi();
}

function onTokenAddrInput() {
  const known = findToken(currentChain().id, val('tokenAddr'));
  state.token = null;
  $('tokenSel').value = known?.address ?? '';
  if (known) {
    $('tokenSym').value = known.symbol;
    $('tokenDec').value = String(known.decimals);
  }
  renderTokenStatus();
  updateAssetUi();
}

function renderTokenStatus() {
  const el = $('tokenStatus');
  const chain = currentChain();
  const addr = val('tokenAddr');
  const known = findToken(chain.id, addr);
  const tk = state.token;
  const parts = [];
  let cls = 'hint';
  if (known) {
    parts.push(t('tok.known'));
    cls = 'hint ok';
  } else if (parseAddress(addr)) {
    parts.push(t('tok.unknown'));
    cls = 'hint warn';
  }
  if (tk && tk.chainId === chain.id && sameAddr(tk.address, addr) && tk.balance !== undefined) {
    parts.push(t('tok.balance', { amount: formatAmount(tk.balance, tk.decimals), sym: tk.symbol || val('tokenSym') }));
  }
  el.textContent = parts.join(' · ');
  el.className = cls;
}

async function queryToken() {
  const acc = requireAccount();
  const chain = currentChain();
  const address = requireAddress(val('tokenAddr'), 'token').address;
  const context = queryContext();
  const client = rpc();
  await assertChain(client, chain.id);
  const info = await getTokenInfo(client, address, acc.address);
  // Dropped if the network, RPC, account or contract changed while waiting.
  if (queryContext() !== context || !sameAddr(val('tokenAddr'), address)) return;
  const known = findToken(chain.id, address);
  $('tokenAddr').value = address;
  $('tokenDec').value = String(info.decimals);
  $('tokenSym').value = known?.symbol ?? info.symbol;
  state.token = { chainId: chain.id, address, ...info };
  if (known && known.decimals !== info.decimals) throw new WalletError('err.decimalsMismatch', { sym: known.symbol, dec: known.decimals });
  renderTokenStatus();
  updateAssetUi();
}

/** The last NFT lookup, only if it was for the network, contract and token ID now in the form. */
function currentNft() {
  const n = state.nft;
  let tokenId;
  try {
    tokenId = parseInteger(val('nftId'), 'tokenId', { hex: true });
  } catch {
    return null;
  }
  return n && n.chainId === currentChain().id && sameAddr(n.address, val('nftAddr')) && n.tokenId === tokenId ? n : null;
}

function renderNftStatus() {
  const el = $('nftStatus');
  const n = currentNft();
  if (!n) {
    el.textContent = '';
    return;
  }
  const name = n.name ? `${n.name} · ` : '';
  if (n.standard === 'erc721') {
    if (n.owned) {
      el.textContent = `ERC-721 · ${name}${t('nft.owned')}`;
      el.className = 'hint ok';
    } else {
      el.textContent = `ERC-721 · ${name}${n.holder ? t('nft.ownedBy', { holder: short(n.holder) }) : t('nft.missing')}`;
      el.className = 'hint bad';
    }
  } else {
    el.textContent = `ERC-1155 · ${name}${t('nft.balance', { n: String(n.balance ?? '?') })}`;
    el.className = n.balance > 0n ? 'hint ok' : 'hint bad';
  }
}

async function queryNft() {
  const acc = requireAccount();
  const chain = currentChain();
  const address = requireAddress(val('nftAddr'), 'token').address;
  const idText = val('nftId');
  const tokenId = parseInteger(idText, 'tokenId', { hex: true });
  const context = queryContext();
  const client = rpc();
  await assertChain(client, chain.id);
  const info = await getNftInfo(client, address, tokenId, acc.address);
  if (queryContext() !== context || !sameAddr(val('nftAddr'), address) || val('nftId') !== idText) return;
  $('nftAddr').value = address;
  $('nftStd').value = info.standard;
  state.nft = { chainId: chain.id, address, tokenId, ...info };
  renderNftStatus();
  updateAssetUi();
}

function updateToHint() {
  const el = $('toHint');
  const text = val('toAddr');
  if (!text) {
    el.textContent = '';
    return;
  }
  const a = parseAddress(text);
  let msg;
  let cls;
  if (!a) [msg, cls] = [t('to.invalid'), 'hint bad'];
  else if (a.checksum === 'invalid') [msg, cls] = [t('to.badChecksum'), 'hint bad'];
  else if (a.checksum === 'none') [msg, cls] = [t('to.noChecksum'), 'hint warn'];
  else [msg, cls] = [t('to.ok'), 'hint ok'];
  if (a && sameAddr(a.address, state.account?.address)) msg += ` ${t('to.self')}`;
  el.textContent = msg;
  el.className = cls;
}

function updateFeeUi() {
  const legacy = radio('feeType') === 'legacy';
  show('fee1559', !legacy);
  show('feeLegacy', legacy);
  updateFeeHint();
}

function updateFeeHint() {
  const chain = currentChain();
  try {
    const gas = parseInteger(val('gasLimit'), 'gas');
    const price = parseGwei(radio('feeType') === 'legacy' ? val('gasPrice') : val('maxFee'), 'fee');
    $('feeHint').textContent = t('send.maxCostHint', { cost: formatAmount(gas * price, 18), sym: chain.symbol }) + (l1Oracle() ? t('send.plusL1') : '');
  } catch {
    $('feeHint').textContent = '';
  }
}

/** Snapshot of the send form, in the same shape as a scanned transfer request. */
function collectRequest() {
  const chain = currentChain();
  const asset = currentAsset();
  const legacy = radio('feeType') === 'legacy';
  const req = {
    chainId: chain.id,
    chainName: chain.name,
    nativeSymbol: chain.symbol,
    from: state.account?.address,
    asset,
    to: val('toAddr'),
    nonce: val('nonce'),
    gas: val('gasLimit'),
    feeType: legacy ? 'legacy' : '1559',
  };
  if (legacy) req.gasPrice = val('gasPrice');
  else Object.assign(req, { maxFee: val('maxFee'), tip: val('tipFee') });
  if (asset === 'native') req.amount = val('amount');
  else if (asset === 'erc20') Object.assign(req, { token: val('tokenAddr'), decimals: val('tokenDec'), symbol: val('tokenSym'), amount: val('amount') });
  else Object.assign(req, { token: val('nftAddr'), tokenId: val('nftId'), amount: asset === 'erc1155' ? val('amount') : '1' });
  return req;
}

/** Puts a scanned request into the form so it is visible exactly as it will be signed. */
function fillForm(req) {
  const nft = req.asset === 'erc721' || req.asset === 'erc1155';
  setRadio('asset', nft ? 'nft' : req.asset);
  if (nft) $('nftStd').value = req.asset;
  $('toAddr').value = req.to ?? '';
  $('amount').value = req.amount ?? '';
  $('nonce').value = req.nonce ?? '';
  $('gasLimit').value = req.gas ?? '';
  state.gasTouched = true;
  setRadio('feeType', req.feeType === 'legacy' ? 'legacy' : '1559');
  $('maxFee').value = req.maxFee ?? '';
  $('tipFee').value = req.tip ?? '';
  $('gasPrice').value = req.gasPrice ?? '';
  if (req.asset === 'erc20') {
    $('tokenAddr').value = req.token ?? '';
    $('tokenSym').value = req.symbol ?? '';
    $('tokenDec').value = req.decimals ?? '';
    renderTokenSelect();
  }
  if (nft) {
    $('nftAddr').value = req.token ?? '';
    $('nftId').value = req.tokenId ?? '';
  }
  state.token = null;
  state.nft = null;
  renderTokenStatus();
  renderNftStatus();
  updateToHint();
  updateFeeUi();
  updateAssetUi();
}

async function fillMax() {
  const asset = currentAsset();
  const chain = currentChain();
  if (asset === 'native') {
    const info = freshInfo();
    if (!info) throw new WalletError('err.needInfo');
    const req = collectRequest();
    if (!parseAddress(req.to)) req.to = info.address;
    const client = rpc();
    const draft = buildTransaction({ ...req, amount: '0' });
    // Fix the gas limit now, so signing uses exactly the fee this amount leaves room for.
    if (!state.gasTouched) {
      const gas = await suggestGasLimit(client, info.address, draft.tx).catch(() => draft.tx.gas);
      $('gasLimit').value = gas.toString();
      state.gasTouched = true;
    }
    const { tx } = buildTransaction({ ...req, amount: '0', gas: val('gasLimit') });
    let reserve = maxCost(tx);
    const oracle = l1Oracle();
    if (oracle) {
      // L1 data fee is charged on top; keep twice the current estimate in reserve. Without
      // an estimate the transaction would be rejected, so do not guess.
      const l1 = await getL1Fee(client, oracle, { ...tx, value: info.balance }).catch(() => {
        throw new WalletError('err.l1Fee');
      });
      reserve += l1 * 2n;
    }
    const max = info.balance - reserve;
    if (max <= 0n) throw new WalletError('err.balanceTooLow');
    $('amount').value = formatAmount(max, 18);
    updateFeeHint();
  } else if (asset === 'erc20') {
    const tk = state.token;
    if (!tk || tk.chainId !== chain.id || !sameAddr(tk.address, val('tokenAddr')) || tk.balance === undefined) throw new WalletError('err.needTokenQuery');
    $('amount').value = formatAmount(tk.balance, tk.decimals);
  } else if (asset === 'erc1155') {
    const n = currentNft();
    if (n?.balance === undefined) throw new WalletError('err.needNftQuery');
    $('amount').value = n.balance.toString();
  }
}

// ---------------------------------------------------------------- review & sign
function actionText(s, chain) {
  if (s.asset === 'native') return t('act.native', { amount: formatAmount(s.amount, 18), sym: chain.symbol });
  if (s.asset === 'erc20') return t('act.erc20', { amount: formatAmount(s.amount, s.decimals), sym: s.symbol || '?' });
  if (s.asset === 'erc721') return t('act.erc721', { id: s.tokenId.toString() });
  return t('act.erc1155', { id: s.tokenId.toString(), n: s.amount.toString() });
}

function feeText(tx) {
  return tx.type === 'legacy'
    ? t('rv.feeLegacy', { price: formatGwei(tx.gasPrice) })
    : t('rv.fee1559', { max: formatGwei(tx.maxFeePerGas), tip: formatGwei(tx.maxPriorityFeePerGas) });
}

function reviewRows(req, built, chain) {
  const s = built.summary;
  const rows = [
    [t('rv.network'), `${chain.name} (chainId ${chain.id})`],
    [t('rv.from'), req.from ?? '—', 'mono'],
    [t('rv.action'), actionText(s, chain)],
    [t('rv.to'), s.recipient, 'mono'],
  ];
  if (s.contract) rows.push([t(s.asset === 'erc20' ? 'rv.tokenContract' : 'rv.nftContract'), s.contract, 'mono']);
  if (s.asset === 'erc20') rows.push([t('rv.rawAmount'), t('rv.rawUnits', { raw: s.amount.toString(), dec: String(s.decimals) })]);
  rows.push(['Nonce', String(s.nonce)], [t('rv.gasLimit'), s.gas.toString()], [t('rv.fee'), feeText(built.tx)]);
  rows.push([t('rv.maxCost'), `${formatAmount(s.maxCost, 18)} ${chain.symbol}${l1Oracle() ? t('send.plusL1') : ''}`]);
  const info = freshInfo();
  if (info) {
    const after = info.balance - s.maxCost - (s.asset === 'native' ? s.amount : 0n);
    rows.push([t('rv.after'), after >= 0n ? `≥ ${formatAmount(after, 18)} ${chain.symbol}` : '—']);
  }
  return rows;
}

function reviewWarnings(req, built, chain) {
  const s = built.summary;
  const w = built.notes.map((key) => ({ text: t(key) }));
  if (sameAddr(s.recipient, req.from)) w.push({ text: t('warn.sameAddress') });
  if (s.asset === 'erc20' && !findToken(chain.id, s.contract)) w.push({ text: t('warn.unknownToken') });
  const info = freshInfo();
  const price = built.tx.maxFeePerGas ?? built.tx.gasPrice;
  if (info) {
    if (s.asset === 'native' && s.amount + s.maxCost > info.balance) w.push({ text: t('warn.insufficient'), danger: true });
    else if (s.maxCost > info.balance) w.push({ text: t('warn.insufficientGas'), danger: true });
    if (s.nonce < info.nonce) w.push({ text: t('warn.nonceLow', { n: info.nonce }), danger: true });
    else if (s.nonce > info.nonce) w.push({ text: t('warn.nonceGap', { n: info.nonce }) });
    const suggested = info.fees.supports1559 ? info.fees.maxFee : info.fees.gasPrice;
    if (price > suggested * 3n + 1_000_000_000n) w.push({ text: t('warn.highFee') });
    if (!info.fees.supports1559 && built.tx.type === 'eip1559') w.push({ text: t('warn.no1559'), danger: true });
  } else if (price > 5000n * 10n ** 9n) {
    w.push({ text: t('warn.highFee') });
  }
  const tk = state.token;
  if (s.asset === 'erc20' && tk?.chainId === chain.id && sameAddr(tk.address, s.contract) && tk.balance !== undefined && s.amount > tk.balance) {
    w.push({ text: t('warn.insufficientToken'), danger: true });
  }
  const n = state.nft;
  if (n?.chainId === chain.id && sameAddr(n.address, s.contract) && n.tokenId === s.tokenId) {
    if (s.asset === 'erc721' && n.standard === 'erc721' && !n.owned) w.push({ text: t('warn.notOwner'), danger: true });
    if (s.asset === 'erc1155' && n.balance !== undefined && s.amount > n.balance) w.push({ text: t('warn.insufficientNft'), danger: true });
    if (n.standard !== s.asset) w.push({ text: t('warn.wrongStandard'), danger: true });
  }
  return w;
}

/** A known token's decimals are authoritative; a request claiming otherwise is refused. */
function checkKnownToken(req, chain) {
  if (req.asset !== 'erc20') return;
  const known = findToken(chain.id, req.token);
  if (known && Number(req.decimals) !== known.decimals) throw new WalletError('err.decimalsMismatch', { sym: known.symbol, dec: known.decimals });
  if (known) req.symbol = known.symbol;
}

/**
 * Plain transfers cost a fixed amount of gas, so the estimate is used as is. Anything larger
 * (contract calls, or transfers on L2s that fold the L1 cost into gas) gets 25% headroom;
 * unused gas is not charged.
 */
async function suggestGasLimit(client, from, tx) {
  const est = await estimateGas(client, { from, to: tx.to, value: tx.value, data: tx.data });
  return est <= 22000n ? est : (est * 125n) / 100n;
}

async function signOrRequest(req, { estimate }) {
  const acc = requireAccount();
  const chain = currentChain();
  if (!req.nonce) throw new WalletError('err.needNonce');
  checkKnownToken(req, chain);
  const extraWarnings = [];
  if (estimate && freshInfo()) {
    const client = rpc();
    const pre = buildTransaction(req);
    if (req.asset !== 'native') {
      // Calling an address without code "succeeds" and does nothing.
      const code = await client.call('eth_getCode', [pre.tx.to, 'latest']).catch(() => undefined);
      if (code === '0x') extraWarnings.push({ text: t('warn.noContract'), danger: true });
    }
    if (!state.gasTouched) {
      try {
        const gas = await suggestGasLimit(client, acc.address, pre.tx);
        req.gas = gas.toString();
        $('gasLimit').value = req.gas;
        updateFeeHint();
      } catch (e) {
        const go = await confirmDialog({
          title: t('est.title'),
          warnings: [{ text: t('est.body', { reason: errorText(e) }), danger: true }],
          ok: t('est.continue'),
        });
        if (!go) return;
      }
    }
  }
  const built = buildTransaction(req);
  const signer = !!acc.privateKey;
  const ok = await confirmDialog({
    title: t(signer ? 'rv.title' : 'rv.titleRequest'),
    rows: reviewRows(req, built, chain),
    warnings: [...extraWarnings, ...reviewWarnings(req, built, chain)],
    ok: t(signer ? 'btn.sign' : 'btn.makeQr'),
  });
  if (!ok) return;
  if (signer) {
    const { raw, hash } = await signTransaction(acc.privateKey, built.tx);
    const tx = { ...built.tx };
    showResult({ kind: 'signed', raw, hash, chainId: chain.id, from: acc.address, tx, token: tokenMeta(req) });
  } else {
    showResult({ kind: 'request', payload: encodeTxRequest(req), req });
  }
}

const tokenMeta = (req) => (req.asset === 'erc20' ? { symbol: req.symbol, decimals: Number(req.decimals) } : undefined);

// ---------------------------------------------------------------- results
function clearResult() {
  state.result = null;
  state.watchId++;
  show('secResult', false);
}

function showResult(r) {
  state.watchId++;
  state.result = r;
  renderResult();
  $('secResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function describeText(d, chain, token) {
  const sym = chain?.symbol ?? '?';
  const known = d.contract && chain ? findToken(chain.id, d.contract) : undefined;
  const tok = known ?? token;
  switch (d.kind) {
    case 'native':
      return t('act.native', { amount: formatAmount(d.value, 18), sym });
    case 'erc20':
      return tok
        ? t('act.erc20', { amount: formatAmount(d.amount, tok.decimals), sym: tok.symbol })
        : t('act.erc20Raw', { raw: d.amount.toString() });
    case 'erc721':
      return t('act.erc721', { id: d.tokenId.toString() });
    case 'erc1155':
      return t('act.erc1155', { id: d.tokenId.toString(), n: d.amount.toString() });
    case 'approve':
      return t('act.approve', { spender: d.spender, raw: d.amount.toString() });
    case 'approveAll':
      return t(d.approved ? 'act.approveAll' : 'act.revokeAll', { operator: d.operator });
    case 'transferFrom':
      return t('act.transferFrom', { raw: d.amount.toString() });
    case 'deploy':
      return t('act.deploy');
    default:
      return t('act.call');
  }
}

function signedTxRows(r) {
  const chain = getChain(r.chainId);
  const d = describeTransaction(r.tx);
  const rows = [
    [t('rv.network'), r.chainId ? `${chain?.name ?? t('res.unknownChain')} (chainId ${r.chainId})` : t('res.noChainId'), chain && r.chainId ? '' : 'bad'],
    [t('rv.from'), r.from, 'mono'],
    [t('rv.action'), describeText(d, chain, r.token)],
  ];
  if (d.recipient) rows.push([t('rv.to'), d.recipient, 'mono']);
  else if (d.to) rows.push([t('rv.to'), d.to, 'mono']);
  if (d.contract) rows.push([t('rv.contract'), d.contract, 'mono']);
  if (d.kind !== 'native' && d.value > 0n) rows.push([t('rv.value'), `${formatAmount(d.value, 18)} ${chain?.symbol ?? ''}`]);
  if (d.extraData) rows.push([t('rv.note'), t('res.extraData'), 'bad']);
  rows.push(['Nonce', String(r.tx.nonce ?? 0)]);
  rows.push([t('rv.maxCost'), `${formatAmount(maxCost({ gas: r.tx.gas ?? 0n, maxFeePerGas: r.tx.maxFeePerGas, gasPrice: r.tx.gasPrice }), 18)} ${chain?.symbol ?? ''}`]);
  rows.push([t('rv.hash'), r.hash, 'mono']);
  return rows;
}

function signatureRows(r) {
  const rows = [[t('msg.address'), r.address, 'mono']];
  if (r.kind === 'scannedSig') {
    rows.push([t('msg.recovered'), r.recovered ?? '—', 'mono']);
    rows.push([t('msg.result'), t(r.valid ? 'msg.valid' : 'msg.invalid'), r.valid ? 'good' : 'bad']);
  }
  rows.push([t('msg.message'), r.message, 'pre']);
  rows.push([t('msg.signature'), r.signature, 'mono']);
  return rows;
}

function renderResult() {
  const r = state.result;
  if (!r) return show('secResult', false);
  const view = {
    signed: () => ({ title: t('res.signed'), qr: signedTxForQr(r.raw), hint: t('res.signedHint'), text: r.raw, rows: signedTxRows(r), broadcast: true }),
    scannedTx: () => ({ title: t('res.scannedTx'), text: r.raw, rows: signedTxRows(r), broadcast: true }),
    request: () => ({
      title: t('res.request'),
      qr: r.payload,
      hint: t('res.requestHint'),
      text: r.payload,
      rows: [[t('rv.action'), actionText(buildTransaction(r.req).summary, getChain(r.req.chainId) ?? currentChain())], [t('rv.to'), r.req.to, 'mono']],
    }),
    msgRequest: () => ({ title: t('res.msgRequest'), qr: r.payload, hint: t('res.msgRequestHint'), text: r.payload, rows: [[t('msg.message'), r.message, 'pre']] }),
    signature: () => ({ title: t('res.signature'), qr: r.payload, hint: t('res.signatureHint'), text: r.payload, rows: signatureRows(r) }),
    scannedSig: () => ({ title: t('res.scannedSig'), text: r.payload, rows: signatureRows(r) }),
  }[r.kind]();
  $('resultTitle').textContent = view.title;
  show('resultQrBox', !!view.qr);
  if (view.qr) {
    $('resultQr').src = qrDataUrl(view.qr);
    $('resultHint').textContent = view.hint;
  }
  fillRows($('resultRows'), view.rows);
  $('resultText').value = view.text;
  show('btnBroadcast', !!view.broadcast);
  show('secResult', true);
  renderBroadcastStatus();
}

function renderBroadcastStatus() {
  const r = state.result;
  const el = $('bcastStatus');
  const s = r?.status;
  $('btnBroadcast').disabled = !!s && ['sending', 'pending', 'success'].includes(s.state);
  if (!s) return show(el, false);
  const chain = getChain(r.chainId);
  const parts = [];
  let cls = 'status';
  if (s.state === 'sending') parts.push(t('bc.sending'));
  if (s.state === 'pending') parts.push(t('bc.pending', { s: String(Math.round((s.elapsed ?? 0) / 1000)) }));
  if (s.state === 'timeout') parts.push(t('bc.timeout'));
  if (s.state === 'success') {
    parts.push(t('bc.success', { block: String(s.blockNumber), gas: s.gasUsed.toString() }));
    cls += ' ok';
  }
  if (s.state === 'reverted') {
    parts.push(t('bc.reverted', { block: String(s.blockNumber) }) + (s.reason ? `\n${t('bc.reason', { reason: s.reason })}` : ''));
    cls += ' bad';
  }
  if (s.state === 'error') {
    parts.push(s.message);
    cls += ' bad';
  }
  el.className = `${cls} pre`;
  el.replaceChildren(parts.join('\n'));
  const url = s.state !== 'error' && s.state !== 'sending' ? explorerTxUrl(chain, r.hash) : '';
  if (url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = t('bc.explorer');
    el.append('\n', a);
  }
  show(el, true);
}

async function broadcast() {
  const r = state.result;
  if (!r?.raw) return;
  const chain = getChain(r.chainId);
  if (!r.chainId || !chain) throw new WalletError('err.unknownChain', { id: String(r.chainId ?? '—') });
  selectChain(chain.id);
  const client = rpc();
  const watch = ++state.watchId;
  const alive = () => state.watchId === watch && state.result === r;
  r.status = { state: 'sending' };
  renderBroadcastStatus();
  try {
    await assertChain(client, chain.id);
    try {
      await sendRawTransaction(client, r.raw);
    } catch (e) {
      // Re-broadcasting the same transaction is harmless; keep following it.
      if (!(e instanceof RpcError && /already known|known transaction|already imported|alreadyknown/i.test(e.message))) throw e;
    }
    r.status = { state: 'pending', elapsed: 0 };
    renderBroadcastStatus();
    const receipt = await waitForReceipt(client, r.hash, {
      isCancelled: () => !alive(),
      onTick: (ms) => {
        if (!alive()) return;
        r.status.elapsed = ms;
        renderBroadcastStatus();
      },
    });
    if (!alive()) return;
    if (!receipt) r.status = { state: 'timeout' };
    else if (receipt.status === 'success') r.status = { state: 'success', ...receipt };
    else {
      const reason = await getRevertReason(client, { from: r.from, to: r.tx.to, data: r.tx.data, value: r.tx.value }, receipt.blockNumber).catch(() => '');
      r.status = { state: 'reverted', reason, ...receipt };
    }
  } catch (e) {
    r.status = { state: 'error', message: errorText(e) };
  }
  if (state.result === r) renderBroadcastStatus();
}

// ---------------------------------------------------------------- messages
async function signMessageFlow(message) {
  const acc = requireAccount();
  if (!message) throw new WalletError('err.messageEmpty');
  if (!acc.privateKey) {
    showResult({ kind: 'msgRequest', payload: encodeMsgRequest({ from: acc.address, message }), message });
    return;
  }
  const ok = await confirmDialog({
    title: t('msg.confirmTitle'),
    rows: [[t('rv.from'), acc.address, 'mono'], [t('msg.message'), message, 'pre']],
    warnings: isHexMessage(message) ? [{ text: t('msg.hexNote') }] : [],
    ok: t('btn.sign'),
  });
  if (!ok) return;
  const signature = await signMessage(acc.privateKey, message);
  showResult({ kind: 'signature', payload: encodeSignature({ address: acc.address, message, signature }), address: acc.address, message, signature });
}

// ---------------------------------------------------------------- scanning
let scanSession = null;

async function openScanner() {
  const dlg = $('dlgScan');
  $('scanText').value = '';
  $('scanStatus').textContent = t('scan.starting');
  const session = { scanner: null, done: false };
  scanSession = session;
  dlg.addEventListener(
    'close',
    () => {
      session.done = true;
      session.scanner?.stop();
      if (scanSession === session) scanSession = null;
    },
    { once: true },
  );
  dlg.showModal();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('scan.noCameraApi'));
    const scanner = await startScanner($('scanVideo'), $('scanOverlay'), (text) => finishScan(text));
    if (session.done) scanner.stop();
    else {
      session.scanner = scanner;
      $('scanStatus').textContent = t('scan.aim');
    }
  } catch (e) {
    if (!session.done) $('scanStatus').textContent = t('scan.cameraError', { msg: e?.message || e?.name || String(e) });
  }
}

function finishScan(text) {
  if ($('dlgScan').open) $('dlgScan').close();
  if (text?.trim()) handleScanned(text).catch(alertError);
}

async function handleScanned(text) {
  const p = decodePayload(text);
  switch (p.type) {
    case 'address':
      return onScannedAddress(p);
    case 'badAddress':
      throw new WalletError('err.addressChecksum', { field: 'qr' });
    case 'txRequest':
      return onScannedRequest(p.request);
    case 'signedTx':
      return onScannedSignedTx(p.raw);
    case 'msgRequest':
      return onScannedMsgRequest(p);
    case 'signature':
      return onScannedSignature(p);
    default:
      throw new WalletError('err.unknownPayload');
  }
}

function onScannedAddress({ address, chainId }) {
  if (!state.account) {
    setAccount({ address, source: 'address' });
    if (chainId && getChain(chainId)) selectChain(chainId);
    toast(t('scan.gotWatch'));
  } else {
    $('toAddr').value = address;
    updateToHint();
    $('toAddr').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(t('scan.gotRecipient'));
  }
}

async function onScannedRequest(req) {
  let chain = getChain(req.chainId);
  if (!chain) {
    const add = await confirmDialog({
      title: t('scan.newChainTitle'),
      rows: [[t('cnet.name'), req.chainName ?? '—'], ['Chain ID', String(req.chainId)], [t('cnet.symbol'), req.nativeSymbol ?? '—']],
      warnings: [{ text: t('scan.newChainWarn') }],
      ok: t('cnet.add'),
    });
    if (!add) return;
    chain = addCustomChain({ name: req.chainName || `Chain ${req.chainId}`, id: req.chainId, symbol: req.nativeSymbol || 'ETH' });
  }
  selectChain(chain.id);
  fillForm(req);
  const acc = state.account;
  if (!acc) throw new WalletError('err.scanNeedKey');
  if (req.from && !sameAddr(req.from, acc.address)) throw new WalletError('err.requestFrom', { from: req.from, mine: acc.address });
  if (!acc.privateKey) {
    toast(t('scan.filled'));
    return;
  }
  await signOrRequest(collectRequest(), { estimate: false });
}

async function onScannedSignedTx(raw) {
  const p = await parseSignedTransaction(raw);
  const chainId = p.tx.chainId;
  if (chainId && getChain(chainId)) selectChain(chainId);
  showResult({ kind: 'scannedTx', raw: p.raw, hash: p.hash, chainId, from: p.from, tx: p.tx });
}

async function onScannedMsgRequest({ from, message }) {
  $('msgInput').value = message;
  $('secAdv').open = true;
  const acc = state.account;
  if (!acc) throw new WalletError('err.scanNeedKey');
  if (from && !sameAddr(from, acc.address)) throw new WalletError('err.requestFrom', { from, mine: acc.address });
  if (acc.privateKey) await signMessageFlow(message);
  else toast(t('scan.filled'));
}

async function onScannedSignature({ address, message, signature }) {
  const recovered = await recoverSigner(message, signature).catch(() => null);
  const valid = !!recovered && sameAddr(recovered, address);
  showResult({ kind: 'scannedSig', payload: encodeSignature({ address, message, signature }), address, message, signature, recovered, valid });
}

// ---------------------------------------------------------------- language
function renderLanguage() {
  applyI18n(document);
  const en = getLang() === 'en';
  document.documentElement.lang = en ? 'en' : 'zh-Hant';
  $('btnLang').textContent = en ? '中文' : 'EN';
  $('btnLang').lang = en ? 'zh-Hant' : 'en';
  $('btnReveal').textContent = t($('keyInput').classList.contains('masked') ? 'acct.show' : 'acct.hide');
  renderChainSelect(currentChain()?.id ?? store.get('oeww.chain', 1));
  renderAccount();
  renderInfo();
  renderTokenSelect();
  renderNftStatus();
  updateToHint();
  updateFeeHint();
  renderResult();
}

// ---------------------------------------------------------------- wiring
function init() {
  initDialogs();
  initLang(store.get('oeww.lang', null));
  loadChains();
  renderChainSelect(store.get('oeww.chain', 1));
  $('derivePath').value = DEFAULT_PATH;

  $('btnLang').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'zh-TW' : 'en');
    store.set('oeww.lang', getLang());
    renderLanguage();
  });

  // account
  $('keyInput').addEventListener('input', () => {
    const text = $('keyInput').value;
    show('mnemonicOpts', classifyInput(text) === 'mnemonic' && /\S\s+\S|\p{Script=Han}/u.test(text.trim()));
  });
  $('btnReveal').addEventListener('click', () => {
    const masked = $('keyInput').classList.toggle('masked');
    $('btnReveal').textContent = t(masked ? 'acct.show' : 'acct.hide');
  });
  action('btnLoad', loadFromInput);
  $('btnKeystore').addEventListener('click', () => $('ksFile').click());
  $('ksFile').addEventListener('change', async () => {
    const file = $('ksFile').files[0];
    $('ksFile').value = '';
    if (!file) return;
    try {
      if (file.size > 100_000) throw new WalletError('err.ksFormat');
      await loadKeystoreText(await file.text());
    } catch (e) {
      await alertError(e);
    }
  });
  action('btnVault', openVault);
  action('btnApplyPath', applyPath);
  action('btnCopyAddr', () => copyText(state.account?.address));
  action('btnAddrQr', showAddressQr);
  action('btnSaveVault', saveToVault);
  action('btnExportKs', exportKeystore);
  action('btnLogout', async () => logout());

  // network
  $('chainSel').addEventListener('change', onChainChange);
  $('rpcUrl').addEventListener('change', onRpcChange);
  action('btnInfo', fetchInfo);

  // send form
  for (const el of document.querySelectorAll('input[name="asset"]')) {
    el.addEventListener('change', () => {
      state.gasTouched = false;
      updateAssetUi();
    });
  }
  $('nftStd').addEventListener('change', () => {
    state.gasTouched = false;
    updateAssetUi();
  });
  $('tokenSel').addEventListener('change', onTokenSelect);
  $('tokenAddr').addEventListener('input', onTokenAddrInput);
  $('tokenSym').addEventListener('input', updateAssetUi);
  $('tokenDec').addEventListener('input', () => {
    state.token = null;
    renderTokenStatus();
  });
  for (const id of ['nftAddr', 'nftId']) $(id).addEventListener('input', renderNftStatus);
  action('btnTokenInfo', queryToken);
  action('btnNftInfo', queryNft);
  $('toAddr').addEventListener('input', updateToHint);
  action('btnMax', fillMax);
  $('gasLimit').addEventListener('input', () => {
    state.gasTouched = true;
    updateFeeHint();
  });
  for (const id of ['maxFee', 'tipFee', 'gasPrice']) $(id).addEventListener('input', updateFeeHint);
  for (const el of document.querySelectorAll('input[name="feeType"]')) el.addEventListener('change', updateFeeUi);
  action('btnSign', () => signOrRequest(collectRequest(), { estimate: true }));

  // result
  action('btnCopyResult', () => copyText($('resultText').value));
  action('btnBroadcast', broadcast, renderBroadcastStatus);

  // advanced
  action('btnSignMsg', () => signMessageFlow($('msgInput').value));
  action('btnAddNet', async () => {
    addCustomChain({ name: val('netName'), id: val('netId'), symbol: val('netSym'), rpc: val('netRpc'), explorer: val('netExplorer') });
    for (const id of ['netName', 'netId', 'netSym', 'netRpc', 'netExplorer']) $(id).value = '';
    toast(t('cnet.added'));
  });
  action('btnDelNet', async () => {
    const chain = currentChain();
    if (!chain.custom) throw new WalletError('err.notCustom');
    if (!(await confirmDialog({ title: t('cnet.delTitle', { name: chain.name }), ok: t('cnet.del') }))) return;
    store.set('oeww.customChains', store.get('oeww.customChains', []).filter((c) => c.id !== chain.id));
    loadChains();
    renderChainSelect(1);
    onChainChange();
  });

  // scanner
  action('btnScan', openScanner);
  $('btnScanUse').addEventListener('click', () => finishScan($('scanText').value));
  $('btnScanImage').addEventListener('click', () => $('scanFile').click());
  $('scanFile').addEventListener('change', async () => {
    const file = $('scanFile').files[0];
    $('scanFile').value = '';
    if (!file) return;
    try {
      finishScan(await decodeImageFile(file));
    } catch {
      $('scanStatus').textContent = t('scan.imageFail');
    }
  });
  $('btnScanSwitch').addEventListener('click', async () => {
    const ok = await scanSession?.scanner?.next().catch(() => false);
    if (!ok) toast(t('scan.oneCamera'));
  });

  // footer
  action('btnCopyDonate', () => copyText('0x7cE987d1C417DBb86CfE6f9Ac6cfEDF7554853AF'));
  action('btnClear', async () => {
    if (!(await confirmDialog({ title: t('foot.clearTitle'), warnings: [{ text: t('foot.clearBody') }], ok: t('foot.clear') }))) return;
    logout();
    for (const id of ['toAddr', 'amount', 'nonce', 'maxFee', 'tipFee', 'gasPrice', 'tokenAddr', 'tokenSym', 'tokenDec', 'nftAddr', 'nftId', 'msgInput']) $(id).value = '';
    setRadio('asset', 'native');
    state.gasTouched = false;
    renderTokenSelect();
    updateToHint();
    updateAssetUi();
  });

  onChainChange();
  updateFeeUi();
  renderLanguage();
}

init();
