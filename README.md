# Overdoing ETH Warm Wallet v2

[中文](#中文) | [English](#english)

> 原版設計：overdoingism ｜ v2 程式碼由 Claude AI（Anthropic）撰寫。
> Original design by overdoingism. v2 code written by Claude AI (Anthropic).

---

## 中文

一個**單一 HTML 檔案**的以太坊（EVM）錢包，可以連線使用，也可以利用 QR 碼在**完全不連網（air-gap）**的裝置上簽名。

只需要 `dist/oeww.html` 這一個檔案：所有程式與函式庫都已內嵌，不會載入任何外部資源；開啟後在你按下「取得資訊」或「廣播」之前，不會發出任何網路請求。

### 功能

- **原生幣、ERC-20 代幣、NFT（ERC-721 / ERC-1155）** 轉帳。
- **簽署訊息**（personal_sign），並可驗證他人的簽名。
- **BIP39 助記詞**：12–24 字、BIP39 密語（passphrase）、自訂衍生路徑（預設 `m/44'/60'/0'/0/0`）。內建英文、繁體中文、簡體中文詞表的檢查碼驗證；其他語言的助記詞仍可依規範正確推導（會先提示）。
- **私鑰保存**（皆為選用）：
  - 以密碼加密存在瀏覽器（scrypt + AES，標準 Keystore V3 格式）。儲存前會清楚說明風險並需勾選同意。
  - 匯入／匯出 **Keystore JSON**，與 MetaMask、MyEtherWallet、geth 相容。
- **EIP-1559 與 Legacy** 交易，依網路自動判斷；自動估算 Gas，L2 的 L1 資料費也會計入「全部」金額。
- **相機掃描 QR**（也可從圖片讀取或貼上文字），中英文介面切換，深色模式，手機版面。
- 內建 21 個網路（Ethereum、Arbitrum、OP、Base、Polygon、BNB Chain、Avalanche、Gnosis、Linea、Scroll、zkSync、Unichain、Mantle、Celo、Sonic、Cronos、Kaia、ETC、ETHW、Sepolia、Hoodi），也可自訂網路與 RPC。

### 三種用法

在「帳戶」貼上什麼，就決定了這台裝置的角色：

| 輸入 | 模式 | 可以做什麼 |
| --- | --- | --- |
| 私鑰或助記詞 | **可簽名** | 簽名；連網時也可直接查詢與廣播（熱錢包） |
| 只有地址 | **僅觀察** | 查詢餘額、產生「待簽 QR」、廣播已簽名的交易 |

#### 離線簽名（air-gap）流程

1. **離線裝置**：載入私鑰或助記詞 →「地址 QR」。
2. **連網裝置**：按「掃描」讀取地址 → 成為觀察帳戶 →「取得資訊」→ 填寫收款地址與數量 →「產生待簽 QR」。
3. **離線裝置**：按「掃描」讀取待簽 QR → 確認內容 →「確認簽名」→ 顯示已簽名交易的 QR。
4. **連網裝置**：按「掃描」讀取已簽名交易 →「廣播」。

離線裝置只會看到交易內容，不需要也不會連網。訊息簽名也是同樣的流程（在「進階」）。

> **相機的限制**：瀏覽器只在安全環境開放相機。電腦上的 Chrome / Edge 以 `file://` 開啟即可使用；iPhone 的 Safari 必須以 `https://`（例如 GitHub Pages）開啟。無法使用相機時，可改用「從圖片讀取」（手機上可直接拍照）或貼上 QR 的文字內容。手機可先以 https 開啟頁面，再切到飛航模式使用。

### 安全設計

- 單一檔案，並以 **Content-Security-Policy** 鎖定：只允許內嵌的那一段程式（以雜湊值驗證）執行，不能載入外部程式碼。
- 簽名前一定會顯示「最終檢查」：網路、發送者、實際動作、收款地址、合約、Nonce、最高手續費，以及各種警告（地址檢核碼、餘額不足、Nonce 異常、手續費過高、收款地址就是代幣合約、合約不存在……）。
- 大小寫混合但 EIP-55 檢核碼錯誤的地址會被拒絕（多半是打錯字）。
- 內建主流代幣清單（已在鏈上驗證小數位數）：離線裝置收到請求時，若代幣在清單中而請求宣稱的小數位數不符，會**拒絕簽名**；不在清單中的代幣會顯示鏈上原始數值供核對。
- 掃描到的請求若指定的發送者與目前載入的私鑰不同，會拒絕簽名。
- 簽章採用 RFC 6979 決定性簽章（同一筆交易永遠得到相同簽章），不依賴離線裝置亂數產生器的品質。

### 從原始碼建置與測試

需要 Node.js 20 以上。

```bash
npm install
npm run build        # 產生 dist/oeww.html
npm test             # 單元測試（BIP39、EIP-155、Keystore 規範向量，並與 ethers 交叉比對）
npm run test:e2e     # 端對端測試：本機 Hardhat 鏈 + 瀏覽器（使用已安裝的 Edge）
npm run verify-tokens  # 檢查內建 RPC 與代幣清單（需連網）
```

原始碼在 `src/`：`core/` 是不依賴瀏覽器的錢包邏輯（金鑰、交易、Keystore、RPC、QR 內容格式），`ui/` 與 `main.js` 是介面。

### 與 v0.99 的差異

- 錢包與「助手（EWWA）」合併為同一個檔案；舊版的 Tx4Sign 碼與新版不相容。
- 不再使用「便記#私鑰」的瀏覽器自動填入，改為加密儲存或 Keystore 檔。
- 不再產生「助手連結」網址 QR，只產生交易本身的 QR。
- web3.js 1.7 改為 viem；jQuery 與 QRCode.js 改為 paulmillr/qr（同時支援產生與掃描）。
- 授權由 LGPLv3 改為 MIT（當初採用 LGPLv3 是為了與 web3.js 相容，新版已不再使用它）。

### 授權

MIT，見 [LICENSE](LICENSE)。內嵌的函式庫（viem、ox、abitype、@noble/\*、@scure/\*、qr）也都以 MIT 授權使用，聲明列於 `dist/oeww.html` 檔頭。

作者對本程式不負任何責任，請先以小額測試。

---

## English

An Ethereum (EVM) wallet in a **single HTML file**. Use it online, or sign on a device that is **never online (air-gapped)**, passing data by QR code.

`dist/oeww.html` is all you need: every library is inlined, nothing external is loaded, and the page makes no network request until you press "Fetch info" or "Broadcast".

### Features

- Send the **native coin, ERC-20 tokens and NFTs (ERC-721 / ERC-1155)**.
- **Sign messages** (personal_sign) and verify signatures.
- **BIP39 mnemonics**: 12–24 words, BIP39 passphrase, custom derivation path (default `m/44'/60'/0'/0/0`). Checksums are verified against the English and Chinese (traditional / simplified) wordlists; mnemonics in other languages still derive correctly after a warning.
- **Optional key storage**:
  - password-encrypted in the browser (scrypt + AES, standard keystore V3), with an explicit risk warning that must be acknowledged;
  - **keystore JSON** import / export, compatible with MetaMask, MyEtherWallet and geth.
- **EIP-1559 and legacy** transactions, chosen per network; gas estimation; "Max" accounts for the L1 data fee on rollups.
- **Camera QR scanning** (or read from an image, or paste), Chinese / English UI, dark mode, phone layout.
- 21 built-in networks plus custom networks and RPCs.

### Three ways to use it

What you paste under "Account" decides the device's role: a private key or mnemonic **can sign** (and, when online, works as a hot wallet); an address alone is **watch-only** (look up balances, create sign requests, broadcast signed transactions).

**Air-gapped flow**

1. Offline device: load the key → "Address QR".
2. Online device: "Scan" the address (watch-only) → "Fetch info" → fill in recipient and amount → "Create sign request QR".
3. Offline device: "Scan" the request → review → "Sign" → it shows the signed transaction as a QR code.
4. Online device: "Scan" the signed transaction → "Broadcast".

Message signing works the same way (under "Advanced").

> **Camera note**: browsers only allow the camera in secure contexts. Chrome / Edge on a computer allow it for `file://`; Safari on iPhone needs `https://` (e.g. GitHub Pages). Without a camera, use "Read from image" (phones can take a photo) or paste the QR text.

### Security

- One file, locked down by a **Content-Security-Policy** that only lets the inlined script (pinned by hash) run.
- Every signature is preceded by a full review with warnings (checksum, balance, nonce, fee, recipient = token contract, missing contract, …).
- Mixed-case addresses with a wrong EIP-55 checksum are rejected.
- A built-in list of major tokens (decimals verified on-chain): an offline signer refuses a request whose decimals contradict the list, and shows raw on-chain amounts for unknown tokens.
- A request for a different sender than the loaded key is refused. Signatures are deterministic (RFC 6979), so they do not depend on the offline device's random number generator.

### Build and test

Node.js 20+:

```bash
npm install
npm run build          # writes dist/oeww.html
npm test               # unit tests (BIP39, EIP-155, keystore vectors; cross-checked with ethers)
npm run test:e2e       # end-to-end: local Hardhat chain + browser (installed Edge)
npm run verify-tokens  # checks built-in RPCs and tokens (needs internet)
```

### License

MIT, see [LICENSE](LICENSE). Version 0.99 and earlier were LGPLv3 only because they embedded web3.js; v2 no longer does. The bundled libraries (viem, ox, abitype, @noble/\*, @scure/\*, qr) are MIT-licensed as well; their notices are in the header of `dist/oeww.html`. No warranty — try a small amount first.
