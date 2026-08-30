# Inline 餐廳自動搶位助手 (Inline Booking Sniper)

專為 **inline.app** 打造的高效能、免受反爬蟲阻擋的瀏覽器自動搶位助手。採用 Tampermonkey (油猴) 腳本架構，直接在您本機已登入的 Google Chrome 中運作，避開 PerimeterX 機器人防護，支援**準時放位開搶 (Opening Drop)** 與 **釋出撿漏輪詢 (Cancellation Sniping)** 雙模式。

---

## 🌟 核心特色

- 🛡️ **原生環境規避反爬蟲**：直接於本機已登入的 Chrome 頁面中運作，避開 `px-captcha` 機器人阻擋與驗證碼風控。
- ⏱️ **伺服器精準對時**：動態取得 Inline 伺服器時間計算真實偏差值（Clock Offset），支援毫秒級（T-180ms）放位倒數精準觸發。
- ⚡ **雙模式搶位架構**：
  - **準時放位開搶 (Opening Drop)**：倒數至指定放位時刻（如 `00:00:00` 或 `12:00:00`），以軟刷新（Soft Re-trigger）與輪詢補償在放位瞬間秒鎖時段。
  - **釋出撿漏輪詢 (Cancellation Sniping)**：以安全隨機間隔持續監控已被訂滿的日期，一旦有人退訂釋出空位立即秒搶。
- 🪑 **用餐桌型智慧偏好 (Table Category Selection)**：
  - **預設首選策略**：自動選取首個可用桌型，免去「請選擇用餐桌型」卡關。
  - **雙向模糊語意比對**：精準支援跨分店異名比對（如：高雄店 `吧台板前` vs 桃園店 `板前吧台` vs 台中店 `板前座位（吧台座位）`）。
- 🎯 **多優先時段清單 (Priority Slot List)**：支援依多個志願時段（如 `18:30, 19:00, 19:30`）循序搶位，大幅提高搶中機率。
- 📝 **智慧姓名雙欄位與表單自動化**：
  - **單/雙欄位相容 (`customerNameFields: 2`)**：自動拆解中文單姓、複姓（如：歐陽、司馬）與英文全名至「姓氏 (`familyName`)」與「名字 (`givenName`)」。
  - **React 18 狀態同步**：重設 React 內部 `_valueTracker` 並派發完整 `InputEvent` 鏈，保證表單驗證狀態即刻更新。
  - **條款自動勾選**：自動勾選用餐須知、inline 服務條款、隱私權政策與行銷優惠同意。
- 🔒 **保證金安全防呆 (Deposit Policy Guard)**：若餐廳需預授權信用卡訂金，腳本會自動鎖定時段並暫停自動送出，響起警報由人工確認輸入卡號，防止誤扣款。
- 🔔 **雙重成功提醒**：Web Audio API 慶祝提示音 + 瀏覽器系統級桌面通知（Notification API）。
- 🎛️ **懸浮控制面板**：頁面右下角常駐精美控制台，支援即時參數設定、本機儲存（LocalStorage）與即時日誌監控。
- 🧪 **自動化測試覆蓋**：內建 41 項單元測試與契約測試（`node --test`），確保核心邏輯穩健可靠。

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
> - **探索/目錄頁面**（例如 `https://dining.inline.app/zh-tw/discover/...`）是餐廳總覽，**尚未進入任何一家店的訂位系統**。
> - 請點選您想預約的餐廳右側「**訂位 &#8599;**」按鈕，進入真正的**店家訂位頁面**（網址開頭為 `https://inline.app/booking/...`）。
> - 頁面右下角會常駐「**⚡ Inline 搶位助手**」懸浮按鈕。

### 第四步：設定搶位參數
點開右下角面板，設定您的預約條件：
- **搶位模式**：
  - 搶凌晨或中午整點剛放出的新日期 ➡️ 選擇「**準時放位開搶**」。
  - 搶已被訂滿的日期釋出空位 ➡️ 選擇「**釋出撿漏輪詢**」。
- **目標日期**：選擇欲用餐日期（例如：`2026-09-20`）。
- **放位時間**：設定店家開放訂位的時刻（通常為 `00:00:00` 或 `12:00:00`）。
- **大人 / 小孩人數**：設定預約人數。
- **優先時段清單**：輸入志願順序（以逗點隔開，例如：`19:00, 19:30, 18:30`）。
- **桌型偏好**：可指定偏好（例如：`板前吧台` 或 `一般座位`），留空則自動選取首個可用桌型。
- **訂位人資料**：填妥姓名、稱謂、電話、Email 與備註需求。
- **免訂金自動送出**：勾選後將在免付費預約時全自動點擊「確認訂位」。

點擊「**💾 儲存設定**」，瀏覽器將自動記錄您的偏好設定，下次開啟免重填。

### 第五步：啟動搶位
- 點擊「**🚀 啟動搶位**」按鈕。
- 面板狀態將轉為「等待開搶」並顯示精準倒數。搶位成功時將響起提示鈴聲並彈出系統通知！

---

## 🧪 測試與驗證

本專案具備完整的自動化測試套件，涵蓋 DOM 轉接器契約、狀態轉移、姓名拆解與保證金防護：

```bash
# 執行全部測試
npm test
# 或直接使用 Node.js 原生 Test Runner
node --test
```

---

## 📚 專案架構與設計決策 (ADR)

- 📘 **[完整使用者操作手冊 (USER_GUIDE.md)](./USER_GUIDE.md)**：包含 Chrome MV3 安裝、參數設定、實戰人機協同與對抗 PerimeterX 按壓防護的完整教學指南。
- 📖 **[領域模型規範 (CONTEXT.md)](./CONTEXT.md)**：定義本系統之領域術語（Reservation, Priority Slot List, Table Category, Deposit Policy 等）。
- 🏛️ **[ADR 0001: Adopt Tampermonkey Userscript Architecture](./docs/adr/0001-userscript-architecture.md)**：說明採用本機油猴腳本而非外部 CDP 腳本以規避 PerimeterX 的架構決策。
- 🏛️ **[ADR 0002: Soft Re-triggering Over Full Page Reload](./docs/adr/0002-soft-retrigger-over-full-reload.md)**：說明開搶時採用毫秒級軟刷新機制以將延遲降至最低的考量。
- 🏛️ **[ADR 0003: DOM Adapter Seam with Automated Tests](./docs/adr/0003-dom-adapter-seam.md)**：說明透過 ReservationTarget 縫隙隔離 DOM 與測試架構的設計模式。

---

## ⚖️ 免責聲明 (Disclaimer)

本專案僅供程式技術研究、自動化測試與個人合法預訂使用。請遵守目標網站的服務條款，切勿用於任何商業轉售或惡意破壞行為。
