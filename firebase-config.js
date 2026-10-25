// 登入 / 雲端存檔的設定。
// 保持 null 時網站不會出現登入功能，資料只存在各自的裝置。
// 把 Firebase 專案的網頁應用程式設定貼進來，就會開啟登入：
//
// export const firebaseConfig = {
//   apiKey: "AIza...",
//   authDomain: "your-project.firebaseapp.com",
//   projectId: "your-project",
//   storageBucket: "your-project.appspot.com",
//   messagingSenderId: "1234567890",
//   appId: "1:1234567890:web:abcdef",
// };
//
// 這些值本來就會公開在網頁上，不是密碼；資料是靠 Firestore 安全規則保護（每個人只能讀寫自己的資料）。

export const firebaseConfig = {
  apiKey: "AIzaSyA21nCRcvSRZWQN83HHA9Mun1b-BG7dBf0",
  authDomain: "work-plan-12b8e.firebaseapp.com",
  projectId: "work-plan-12b8e",
  storageBucket: "work-plan-12b8e.firebasestorage.app",
  messagingSenderId: "82810898296",
  appId: "1:82810898296:web:641b5c959598f9f6d16a8d",
};
