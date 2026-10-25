# 兼職排班

用 GitHub Pages 架設的兼職排班網站，手機和電腦都能開，可以「加到主畫面」當 App 用，沒有網路也能開。

## 功能

- **月曆**：一眼看整個月的班，不同工作用不同顏色
- **新增班次**：選工作後自動帶入這份工作上次的上下班時間和休息時間，以及工作的時薪，改一下就好；可設定「之後每週重複」
- **跨夜班**：結束時間早於開始時間時，自動當成隔天下班
- **課表**：把每週的課加進來，跟打工的班排在同一張週課表上，一眼看出空堂；點空白處就能直接排班
- **撞課提醒**：排的班跟上課時間撞到時會警告；可設定學期日期，寒暑假就不會顯示課
- **分享給朋友**：一鍵分享網址，每個人的資料都只存在自己的手機
- **清單**：照日期列出本月每個班
- **撞班提醒**：排班時如果跟其他班時間重疊（包含跨夜班），會馬上警告，月曆和清單上也會標 ⚠️
- **複製一週**：把某一週的班一鍵複製到另一週，已經有的班會自動跳過
- **存錢目標**：設定每月想賺多少，小豬存錢筒會顯示進度，達成時撒花慶祝 🎉
- **統計**：本月薪資、工時、班數，各工作明細，以及全年累計
- **備份**：匯出或匯入 JSON 檔，換手機或想在電腦上看時用來搬資料
- **登入**（選用）：用 Google 或 Email 登入後資料存到雲端，換手機、刪掉 App 都不會不見

> 時薪會記在每個班上。之後調整某份工作的時薪，只影響新排的班，過去的薪資不會被改掉。

---

## 架上 GitHub Pages（約 2 分鐘）

1. 把這個分支合併到 `main`（或直接用目前的分支）。
2. 到 GitHub repo 頁面 → **Settings** → 左側 **Pages**。
3. **Source** 選 **Deploy from a branch**，Branch 選 `main`、資料夾選 `/ (root)`，按 **Save**。
4. 等一兩分鐘，網址會是：
   **https://coolalxeanderyi.github.io/Work-Plan/**

### 加到手機主畫面

- **iPhone（Safari）**：分享按鈕 → 「加入主畫面」
- **Android（Chrome）**：右上角選單 → 「安裝應用程式」或「加到主畫面」

完成到這裡就能用了。資料只存在那台裝置的瀏覽器裡，記得偶爾到「設定 → 匯出備份」。

---

## 開啟登入功能（Firebase，免費）

`firebase-config.js` 是 `null` 時不會出現登入功能。開啟方式：

1. 到 <https://console.firebase.google.com/> 建立專案（Google Analytics 可關閉）。
2. 專案首頁新增**網頁應用程式**（`</>` 圖示），複製出現的 `firebaseConfig`，貼進 `firebase-config.js` 取代 `null`。這些值不是密碼，放在公開 repo 沒問題。
3. **Authentication** → Sign-in method：啟用 **Google** 和 **電子郵件/密碼**。
4. **Authentication** → Settings → Authorized domains：加入 `coolalxeanderyi.github.io`。
5. **Firestore Database** → 建立資料庫（地區選 `asia-east1` 台灣，正式版模式）。
6. Firestore → **規則**，換成下面這段後發布（每個人只能讀寫自己的資料）：

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

> 專案管理者在 Firebase 後台看得到所有使用者的資料，分享給朋友前可以先說一聲。

---

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | 頁面結構 |
| `style.css` | 樣式（自動支援深色模式） |
| `app.js` | 主要功能：排班、課表、統計、備份、登入 |
| `firebase-config.js` | 登入功能的設定（選填） |
| `sw.js` | 離線快取 |
| `manifest.json`、`icons/` | 加到主畫面用的 App 資訊和圖示 |

純 HTML／CSS／JavaScript，不需要安裝或編譯。本機測試可以執行 `python3 -m http.server`，再打開 <http://localhost:8000>。

> 有網路時一打開就是最新版；沒網路時會顯示上次存下來的版本。
