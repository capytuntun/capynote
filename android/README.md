# capynote Android

把 capynote 網站包成 Android APP：一個全螢幕 WebView 載入你自己架的 capynote 網址。
**帳號、筆記、檔案、分享全部就是網站本身**——APP 不存第二份資料，用同一個登入 cookie
（`rn_session`）打同一組 `/api`，所以手機上改的東西，電腦瀏覽器下一秒就看得到，反過來也一樣。

原生端只補 WebView 自己做不到的事：

| 事情 | 做法 |
|---|---|
| 第一次開啟 | `SetupActivity`：輸入伺服器網址，`GET /api/health` 測通了才存 |
| 登入狀態 | WebView 的 `CookieManager` 持久化，關掉 APP 再開還是登入中 |
| 上傳／貼圖／匯入 .md | `onShowFileChooser` → 系統檔案選取器（支援多選） |
| 匯入整個資料夾 | Android 沒有 `webkitdirectory` 選取器：`inject.js` 攔下那個 input 的點擊，`FolderPick.kt` 開系統的「選擇資料夾」、走完整棵樹，每個檔案以同源假網址 `/__capynote/pick/…` 串流給網頁做成 `File`（含 `webkitRelativePath`），網站的匯入流程原封不動 |
| 下載（備份 zip、檔案管理、檔案筆記） | `DownloadListener` → 系統 `DownloadManager`，帶登入 cookie 串流 |
| 匯出（CSV／PNG／SVG／docx／電子書 HTML） | 網站用的是 `<a download>` + `blob:`，`res/raw/inject.js` 攔下來轉 base64，`Downloads.kt` 寫進「下載」 |
| PDF 列印 | `js/pdf.js` 偵測到 `window.capynoteAndroid` 時把排版前的 HTML 交給 `Printer.kt`，用隱藏 WebView 跑同一套 paged.js，再開系統列印對話框（選「儲存為 PDF」） |
| 外部連結、`window.open` | 同站的在 APP 內開，站外的交給瀏覽器 |
| 深淺色 | `inject.js` 盯著 `<html data-theme>`，狀態列顏色跟著網站主題 |
| 返回鍵 | 網站每一頁都有 `pushState`，返回鍵就是網站的上一頁；到底才離開 |
| 連不上 | 原生的錯誤畫面：重試／更改伺服器 |
| 換伺服器、清登入 | 網站帳號選單的「APP 設定」（只有在 APP 裡才看得到） |

網站端為此改的地方只有三處：`index.html` 的 `#android-settings-btn`、`js/auth.js` 顯示它、
`js/pdf.js` 的 `androidPrint()`。全部都以 `window.capynoteAndroid` 存在與否判斷，瀏覽器裡行為不變。

## 建置

需要 JDK 17 與 Android SDK（platform 35、build-tools 35.0.0）。沒有 Android Studio 也可以：

```
# Windows（PowerShell）
$env:JAVA_HOME = "C:\path\to\jdk-17"
$env:ANDROID_HOME = "C:\path\to\android-sdk"
cd android
.\gradlew.bat assembleDebug        # app\build\outputs\apk\debug\app-debug.apk
.\gradlew.bat assembleRelease      # app\build\outputs\apk\release\app-release.apk
```

正式版簽章：在 `android/keystore.properties`（已 gitignore）寫

```
storeFile=C:/path/to/capynote-release.jks
storePassword=…
keyAlias=capynote
keyPassword=…
```

沒有這個檔，release 會用 debug 金鑰簽。**金鑰與密碼要自己備份**：之後的更新版必須用同一把金鑰簽，
手機才願意直接覆蓋安裝。

## 安裝到手機

`adb install -r app-release.apk`，或把 APK 傳到手機上點開安裝（要允許「安裝未知來源的應用程式」）。
開啟後輸入伺服器網址（跟瀏覽器打開的一樣，例如 `https://notes.example.com`），登入即可。

## 限制

- 需要網路：沒有離線模式，離線時顯示「連不上伺服器」。
- 「匯入整個資料夾」最多 2000 個檔案、單檔 200 MB（超過的略過並提示）；`.` 開頭的隱藏資料夾不匯。
- 行事曆提醒跟網站一樣只在頁面開著時發，APP 不在前景就不會通知。
- 返回鍵走網站自己的 `history.back()`（回到首頁再按一次才離開），不是 WebView 的 `canGoBack()`：Chromium 會把沒有使用者手勢的 `pushState`（開啟時自動打開上次的筆記）當成可跳過的歷史，`canGoBack()` 會回 false。
- https 信任系統憑證與**使用者自己安裝的 CA**（設定 → 安全性與隱私權 → 更多安全性設定 → 安裝憑證 → CA 憑證）：自簽憑證的伺服器把它的 CA 裝到手機上就能連；沒有 CA 的純自簽伺服器憑證還是連不上，請用 Let's Encrypt／cloudflared，或區網用 http。
- minSdk 29（Android 10）。
