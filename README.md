# 兼職排班

用 GitHub Pages 架設的兼職排班網站，手機和電腦都能開，可以「加到主畫面」當 App 用，沒有網路也能開。

## 功能

- **月曆**：一眼看整個月的班，不同工作用不同顏色
- **新增班次**：選工作後自動帶入預設時間、休息時間和時薪；可設定「之後每週重複」
- **跨夜班**：結束時間早於開始時間時，自動當成隔天下班
- **清單**：照日期列出本月每個班
- **統計**：本月薪資、工時、班數，各工作明細，以及全年累計
- **備份**：匯出或匯入 JSON 檔
- **雲端同步**（選用）：用 Google 登入後，所有裝置看到同一份班表

> 時薪會記在每個班上。之後調整某份工作的時薪，只影響新排的班，過去的薪資不會被改掉。

---

## 一、架上 GitHub Pages（約 2 分鐘）

1. 把這個分支合併到 `main`（或直接用目前的分支）。
2. 到 GitHub repo 頁面 → **Settings** → 左側 **Pages**。
3. **Source** 選 **Deploy from a branch**，Branch 選 `main`、資料夾選 `/ (root)`，按 **Save**。
4. 等一兩分鐘，網址會是：
   **https://coolalxeanderyi.github.io/Work-Plan/**

### 加到手機主畫面

- **iPhone（Safari）**：分享按鈕 → 「加入主畫面」
- **Android（Chrome）**：右上角選單 → 「安裝應用程式」或「加到主畫面」

完成到這裡就能用了。沒有設定雲端同步時是**本機模式**，資料只存在那台裝置的瀏覽器，記得偶爾到「設定 → 匯出備份」。

---

## 二、開啟雲端同步（選用，約 10 分鐘，免費）

1. 到 <https://console.firebase.google.com/> 用 Google 帳號登入 → **建立專案**（名稱隨意，Google Analytics 可以關掉）。
2. **新增網頁應用程式**：專案首頁點 `</>` 圖示 → 取個暱稱 → 註冊。畫面會出現一段 `firebaseConfig = { ... }`，先複製起來。
3. **開啟 Google 登入**：左側 **Authentication** → 開始使用 → **Sign-in method** → 啟用 **Google**。
4. **加入授權網域**：Authentication → **Settings** → **Authorized domains** → 新增 `coolalxeanderyi.github.io`。
5. **建立資料庫**：左側 **Firestore Database** → 建立資料庫 → 地區選 `asia-east1`（台灣）→ 以**正式版模式**開始。
6. **設定安全規則**：Firestore → **規則** 分頁，整段換成下面這樣後按「發布」：

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```

   這樣每個人只能讀寫自己的資料。

7. 打開 repo 裡的 `firebase-config.js`，把第 2 步複製的設定貼進去，取代 `null`：

   ```js
   export const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "...",
   };
   ```

   這些值本來就會出現在網頁上，不是密碼，放進公開 repo 沒問題；資料是靠第 6 步的規則保護。

8. 存檔推上 GitHub，等 Pages 更新後，到網站的 **設定 → 用 Google 登入**。右上角小圓點變綠色就是同步中。

在其他裝置用同一個 Google 帳號登入即可。原本存在裝置上的資料會自動合併上去，不會被覆蓋。

---

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | 頁面結構 |
| `style.css` | 樣式（自動支援深色模式） |
| `app.js` | 主要功能：排班、統計、同步 |
| `firebase-config.js` | 雲端同步設定（選填） |
| `sw.js` | 離線快取 |
| `manifest.json`、`icons/` | 加到主畫面用的 App 資訊和圖示 |

純 HTML／CSS／JavaScript，不需要安裝或編譯。本機測試可以執行 `python3 -m http.server`，再打開 <http://localhost:8000>。

> 更新網站後，手機上可能要重新整理兩次才會看到新版（第一次會先載入快取）。
