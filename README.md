# 誰是臥底 · 青花瓷中國風分組版

青花瓷中國風的分組「誰是臥底」網頁遊戲，使用 Firebase（Authentication + Firestore + Hosting）。

| 頁面 | 給誰用 | 功能 |
| --- | --- | --- |
| `host.html` | 主持人（筆電／平板） | 主控台：Google 登入（白名單）、桌列表與組別管理、**所有桌一起開始**／全部揭曉／全部回到待命 |
| `questions.html` | 主持人 | 題目設計：編輯五題的平民詞／臥底詞（題庫共用於所有桌） |
| `player.html` | 玩家（手機） | 選擇或建立「桌」（不需登入）、建立／加入組別；開始前為待命畫面，開始後看到本組答案 |
| `screen.html` | 投影幕（全場一台） | 待命時顯示「客」的 QR Code（連到玩家頁），開始後大字倒數，揭曉時提示看手機；不顯示桌的資訊與題目 |

## 遊戲流程

1. 投影幕開 `screen.html`，按右下角「全螢幕」。畫面上是給玩家掃的 QR Code。
2. 玩家掃碼 → **找到自己那一桌按「加入」，沒有就建立一桌**（不需登入，任何人都能建立）→ 建立組別，同組的人按「加入」。主持人也可以在主控台先新增各桌。
3. 主持人開 `host.html` → Google 登入（需在白名單）→ 到「題目設計」編輯並儲存五題。
4. **主持人按下開始前，所有玩家畫面都是待命狀態。**
5. 主控台設定倒數秒數 → 按 **所有桌一起開始**：
   - **每一桌各自從題庫隨機抽一題**，同一桌在不同輪次**不會抽到重複的題目**（五題、玩兩輪綽綽有餘）。
   - 每個有 2 組以上的桌同時收到答案；每一桌**各自隨機一組**拿到臥底詞，其他組拿到平民詞。組數不足的桌維持待命。
   - 同一組的所有手機看到同一個詞；別組讀不到你們的詞（由 Firestore 規則保護）。
   - 投影幕開始倒數，最後 10 秒變紅，結束顯示「時間到」。
6. 討論後按 **全部揭曉臥底** → 各組手機顯示自己是不是臥底，以及本桌的兩個詞（投影幕只提示看手機，因為各桌題目不同）。
7. 按 **全部回到待命** → 準備下一輪。新的一場遊戲開始前，按 **重置輪次** 會清空各桌的出題紀錄。主控台點桌的「管理」可淘汰／復活／刪除組別，出局組不會收到答案、也不會被抽成臥底。

## 設定 Firebase（約 10 分鐘）

1. 到 [Firebase Console](https://console.firebase.google.com/) 建立專案。
2. **Authentication → 登入方式**：啟用 **Google** 與 **匿名**。
3. **Firestore Database**：建立資料庫（正式版模式即可，規則下面會部署）。
4. **專案設定 → 一般 → 你的應用程式**：新增「網頁應用程式」，記下設定值（apiKey、authDomain、projectId…）。
5. **Authentication → 設定 → 授權網域**：新增 `ntustcdvc1979.github.io`（否則 Google 登入會失敗）。
6. 部署 Firestore 規則（需要 Node.js；也可以把 `firestore.rules` 內容直接貼到 Console 的「規則」分頁發布）：

   ```bash
   npm install -g firebase-tools@latest
   firebase login
   firebase use --add
   firebase deploy --only firestore:rules
   ```

## 部署前端到 GitHub Pages

前端由 GitHub Actions（`.github/workflows/pages.yml`）自動部署，**Firebase 設定不放在 git**，而是部署時從 Repository secrets 產生 `firebase-config.js`。

1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**，新增：

   | Secret 名稱 | 對應 Firebase 設定 |
   | --- | --- |
   | `FIREBASE_API_KEY` | apiKey |
   | `FIREBASE_AUTH_DOMAIN` | authDomain |
   | `FIREBASE_PROJECT_ID` | projectId |
   | `FIREBASE_STORAGE_BUCKET` | storageBucket |
   | `FIREBASE_MESSAGING_SENDER_ID` | messagingSenderId |
   | `FIREBASE_APP_ID` | appId |

2. **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. 推送到 `main`（或到 **Actions → Deploy to GitHub Pages → Run workflow** 手動執行）。
4. 網址：`https://ntustcdvc1979.github.io/WhoIsTheSpy/`
   - 主持台：`…/WhoIsTheSpy/host.html`
   - 投影幕：`…/WhoIsTheSpy/screen.html`
   - 玩家：掃投影幕 QR Code

> 也仍可改用 Firebase Hosting：`firebase deploy`（會自動提供設定，不需要 secrets）。

### 設定主持人白名單（必要）

**建立桌任何人都可以**；但只有白名單內的 Google 帳號能編輯題目與操控流程（開始、揭曉、回大廳、淘汰／刪除組別），且可操控任何桌。白名單放在 Firestore 而不是程式碼，避免信箱公開在 git 上：

1. Firebase Console → Firestore Database → 開始集合，集合 ID 填 `admin`。
2. 文件 ID 填 `hosts`，新增欄位 `emails`，類型選 **array**，加入主持人的 Google 信箱（字串）。
3. 之後要加減主持人，直接在 Console 編輯這個陣列即可，不需重新部署。

`admin/*` 被規則完全鎖住，前端讀不到也寫不了。

### 本機測試

最簡單：`firebase serve`（會自動提供 `/__/firebase/init.json`）。

若用其他靜態伺服器，請把 `public/js/firebase-config.example.js` 複製成 `public/js/firebase-config.js` 並填入設定。這個檔案已列在 `.gitignore`，**不會被推上 git**。

```bash
npx serve public
```

## 資安說明

- **Firebase Web 設定（含 apiKey）本質上就是公開的**：任何網頁版 Firebase App 都必須把它送到瀏覽器，打開開發者工具就看得到，所以它不是密碼。本專案仍不把它放進 git，部署時由 GitHub Actions secrets 產生。
- 真正的保護靠這幾層（建議都做）：
  1. **Firestore 規則**（`firestore.rules`）：任何人可建立空桌，但只有白名單主持人能編輯題目、操控流程、看到臥底；每位玩家同一時間只屬於一組，只讀得到自己那組的答案；遊戲進行中不能換組偷看。
  2. **限制 API 金鑰**：Google Cloud Console → API 和服務 → 憑證 → 該 Browser key → 「應用程式限制」選 HTTP 參照網址，填 `https://ntustcdvc1979.github.io/*`、`https://你的專案.firebaseapp.com/*`（Google 登入彈窗會用到）（本機測試再加 `http://localhost:*/*`）。
  3. **Authentication 授權網域**只保留你實際使用的網域。
  4. **主持人白名單**放在 Firestore `admin/hosts`，見上方說明。
- 無法完全防止的：玩家開無痕視窗用另一個匿名身分加入別組，或直接偷看別組手機，這屬於遊戲規則的範圍。
- **真正的機密**（服務帳戶金鑰 `*-firebase-adminsdk-*.json`、`.env`）本專案用不到，也都被 `.gitignore` 排除，請勿放進 `public/`。

## 資料結構

```
bank/questions               五題題庫（只有白名單主持人可讀寫）
game/state                   全場狀態：status、round、roundCount、duration、startedAt（投影幕倒數用）
rooms/{桌id}                 name、status(lobby|playing|revealed)、round、duration、startedAt、roundId、reveal、createdBy、usedQ（此桌已出過的題目索引）
rooms/{房號}/private/state   本輪臥底組（只有主持人可讀，揭曉時才複製到 reveal）
rooms/{房號}/groups/{id}     組名、members（匿名 uid）、eliminated
rooms/{房號}/members/{uid}   該玩家目前所屬組別 gid（讀答案以此為準，一人只屬一組）
rooms/{房號}/words/{組id}    本組答案（只有組員與主持人可讀）
```

## 注意

- 倒數以 Firestore 伺服器時間為起點，投影幕電腦的系統時間若差很多會影響倒數，請開啟自動校時。
- 玩家換手機或清除瀏覽器資料會變成新身分，重新加入組別即可。
