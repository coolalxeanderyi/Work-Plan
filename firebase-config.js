// 雲端同步設定（選填）
// 保持 null = 本機模式，資料只存在目前的瀏覽器。
// 要跨裝置同步：照 README「開啟雲端同步」的步驟，把 Firebase 給你的設定貼進來，例如：
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
// 這些值本來就會公開在網頁上，不是密碼；資料安全靠 Firestore 規則保護。

export const firebaseConfig = null;
