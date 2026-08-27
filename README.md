# Inline 餐廳自動搶位助手 (Inline Booking Sniper)

專為 **inline.app** 打造的高效能、免受反爬蟲阻擋的瀏覽器自動搶位助手。採用 Tampermonkey (油猴) 腳本架構，直接在您本機已登入的 Google Chrome 中運作，避開 PerimeterX 機器人防護，支援**準時放位開搶**與**釋出撿漏輪詢**雙模式。

---

## 🌟 核心特色

- 🛡️ **原生環境規避反爬蟲**：直接於已登入的本機 Chrome 頁面運作，免除 `px-captcha` 機器人阻擋。
- ⏱️ **伺服器精準對時**：動態取得 inline 伺服器時間計算偏差值（Offset），支援毫秒級（T-180ms）倒數觸發。
- ⚡ **雙模式搶位**：
  - **準時放位開搶 (Opening Drop)**：倒數至指定放位時刻（如 00:00:00），以混合刷新（Soft Re-trigger / Hard Reload）瞬間鎖定時段。
  - **釋出撿漏輪詢 (Cancellation Sniping)**：以 3~6 秒安全隨機間隔持續監控已滿時段，一旦釋出空位立即秒搶。
- 🎯 **優先時段清單 (Priority Slot List)**：支援依多個志願時段（如 `18:30, 19:00, 19:30`）循序搶位，提升成功率。
- 📝 **表單與用餐須知自動化**：自動同意用餐須知、設定人數、填寫聯絡資料、勾選條款。
- 🔒 **保證金安全防呆**：若餐廳需預授權信用卡訂金，腳本會自動鎖定時段並暫停自動送出，發出警報由人工確認，守護資安與防誤刷。
- 🔔 **雙重成功提醒**：Web Audio API 慶祝提示音 + 瀏覽器系統級桌面通知（Notification API）。
- 🎛️ **懸浮控制台**：網頁右下角自帶精美收折控制台，可直接在畫面上即時調整設定與查看即時日誌（Log）。

---

## 🚀 快速安裝與使用步驟

### 第一步：安裝 Tampermonkey 擴充功能並啟用開發人員模式
1. 前往 [Chrome 線上應用程式商店 - Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) 點擊「加到 Chrome」完成安裝。
2. **⚠️ 關鍵步驟（Chrome Manifest V3 必做）**：
   - 在網址列輸入 `chrome://extensions` 並按下 Enter。
   - 將右上角的「**開發人員模式 (Developer mode)**」切換為**開啟**（否則 Chrome 會禁止 Tampermonkey 執行任何使用者腳本）。

### 第二步：載入搶位腳本
1. 點擊 Chrome 工具列的 Tampermonkey 圖示，選擇「**新增腳本**」。
2. 將本專案中的 [`inline-reservation-bot.user.js`](./inline-reservation-bot.user.js) 內容完整複製貼入編輯器中。
3. 按快捷鍵 `Ctrl + S` (Mac: `Cmd + S`) 儲存腳本。

### 第三步：開啟目標餐廳訂位頁面
> [!IMPORTANT]
> - **探索/目錄頁面**（例如 `https://dining.inline.app/zh-tw/discover/...`）是餐廳列表總覽，**尚未進入任何一家店的訂位系統**。
> - 請在該列表內點選您想預約的餐廳右側「**訂位 &#8599;**」按鈕，進入真正的**店家訂位頁面**（網址開頭為 `https://inline.app/booking/...`）。
> - 頁面右下角會常駐「**⚡ Inline 搶位助手**」懸浮按鈕。在探索頁面亦可預先設定個人資料並儲存。

### 第四步：設定搶位參數
點開右下角面板，設定您的預約條件：
- **搶位模式**：
  - 搶凌晨或中午整點剛放出的新日期 ➡️ 選擇「**準時放位開搶**」。
  - 搶已被訂滿的日期釋出空位 ➡️ 選擇「**釋出撿漏輪詢**」。
- **目標日期**：選擇欲用餐日期（例如：`2026-09-20`）。
- **放位時間**：設定店家開放訂位的時刻（通常為 `00:00:00` 或 `12:00:00`）。
- **大人 / 小孩人數**：設定預約人數。
- **優先時段清單**：輸入志願順序（以逗點隔開，例如：`19:00, 19:30, 18:30`）。
- **訂位人資料**：填妥姓名、稱謂、電話、Email 與備註需求。
- **免訂金自動送出**：勾選後將在免付費預約時自動點擊「確認訂位」。

點擊「**💾 儲存設定**」，瀏覽器將自動記錄您的偏好設定，下次開啟免重填。

### 第五步：啟動搶位
- 點擊「**🚀 啟動搶位**」按鈕。
- 面板狀態將轉為「等待開搶」並顯示精準倒數。搶位成功時將響起提示鈴聲並彈出系統通知！

---

## 📚 專案架構與領域規範

- 📘 **[完整使用者操作手冊 (USER_GUIDE.md)](./USER_GUIDE.md)**：包含 Chrome MV3 安裝、參數設定、實戰人機協同與對抗 PerimeterX 按壓防護的完整教學指南。
- 📖 [CONTEXT.md](./CONTEXT.md)：定義本系統之領域術語（如 Reservation, Priority Slot List, Deposit Policy 等）。
- 🏛️ [ADR 0001: Adopt Tampermonkey Userscript Architecture](./docs/adr/0001-userscript-architecture.md)：說明採用本機油猴腳本而非外部 CDP 腳本以規避 PerimeterX 的架構決策。
- 🏛️ [ADR 0002: Soft Re-triggering Over Full Page Reload](./docs/adr/0002-soft-retrigger-over-full-reload.md)：說明開搶時採用毫秒級軟刷新機制以將延遲降至最低的考量。
