# Inline 餐廳自動搶位助手 (Inline Booking Sniper)

專為 **inline.app** 訂位平台打造的瀏覽器自動搶位助手。正式使用建議安裝為 **Tampermonkey userscript**：支援**準時放位開搶 (Opening Drop)**，也能在**釋出撿漏 (Cancellation Sniping)** 時真正重新整理頁面並自動恢復監控。Console（主控台）貼上方式仍可用於單次測試與準時放位，但無法跨頁面重新整理續跑。

<p align="center">
  <img src="./docs/infographic.jpg" alt="Inline 搶位助手全自動指南 Infographic" width="480" />
</p>

---

## 🌟 核心特色

- 🐒 **Tampermonkey 常駐執行**：userscript 會在 inline 訂位頁自動載入；撿漏重新整理後會依相同 Booking Target 與已儲存設定自動續跑。
- 🛡️ **原生環境規避反爬蟲**：直接於本機已登入的 Chrome 頁面中運作，避開 `px-captcha` 機器人阻擋與驗證碼風控。
- ⏱️ **伺服器精準對時**：動態取得 Inline 伺服器時間計算真實偏差值（Clock Offset），支援毫秒級（T-180ms）放位倒數精準觸發。
- ⚡ **雙模式搶位架構**：
  - **準時放位開搶 (Opening Drop)**：倒數至指定放位時刻（如 `00:00:00` 或 `12:00:00`），以軟刷新（Soft Re-trigger）與輪詢補償在放位瞬間秒鎖時段。
  - **釋出撿漏輪詢 (Cancellation Sniping)**：以隨機間隔真正重新整理訂位頁，重新取得反白日期的伺服器狀態；頁面載入後由 Tampermonkey 自動恢復，一旦解除反白並出現時段便立即嘗試預訂。
- 🪑 **用餐桌型智慧偏好 (Table Category Selection)**：
  - **預設首選策略**：自動選取首個可用桌型，免去「請選擇用餐桌型」卡關。
  - **雙向模糊語意比對**：精準支援跨分店異名比對（如：高雄漢神店 `吧台板前` vs 桃園店 `板前吧台` vs 台中店 `板前座位（吧台座位）`）。
- 🎯 **多優先時段清單 (Priority Slot List)**：支援依多個志願時段（如 `18:30, 19:00, 19:30`）循序搶位，大幅提高搶中機率。
- 📝 **智慧姓名雙欄位與表單自動化**：
  - **單/雙欄位相容 (`customerNameFields: 2`)**：自動拆解中文單姓、複姓（如：歐陽、司馬）與英文全名至「姓氏 (`familyName`)」與「名字 (`givenName`)」。
  - **React 18 狀態同步**：重設 React 內部 `_valueTracker` 並派發完整 `InputEvent`、`change`、`blur` 事件鏈，保證表單驗證狀態即刻更新。
  - **條款自動勾選**：自動勾選用餐須知、inline 服務條款、隱私權政策與店家行銷優惠同意。
- 📅 **日曆跨月份自動導航與熔斷防呆 (Fail-Fast Guard)**：自動翻頁至未來指定月份，若目標日期尚未開放則嚴格暫停搶位，徹底杜絕誤訂預設錯誤月份。
- 🔒 **保證金安全防呆 (Deposit Policy Guard)**：若餐廳需預授權信用卡訂金，腳本會自動鎖定時段並暫停自動送出，響起警報由人工確認輸入卡號，防止誤扣款。
- 🧹 **一鍵快取清除 (Clear Site Cache)**：面板內建快取重設功能，一鍵清除 LocalStorage、SessionStorage 與快取數據，並智慧保留搶位偏好。
- 🔔 **雙重成功提醒**：Web Audio API 慶祝提示音 + 瀏覽器系統級桌面通知（Notification API）。
- 🎛️ **懸浮控制面板**：貼上執行後面板自動展開，支援即時參數設定、本機儲存（LocalStorage）與即時日誌監控。
- 🧪 **自動化測試覆蓋**：內建 66 項單元測試與契約測試（`npm test`），確保核心邏輯穩健可靠。

---

## 🚀 Tampermonkey 安裝與使用

### 步驟一：安裝 Tampermonkey 與 userscript

1. 從 [Tampermonkey 官方網站](https://www.tampermonkey.net/) 安裝符合瀏覽器的擴充功能。
2. 開啟 [`inline-reservation-bot.user.js`](https://raw.githubusercontent.com/huijoson/inline-agent/main/inline-reservation-bot.user.js)；Tampermonkey 應顯示 userscript 安裝畫面。
3. 確認腳本版本為 `2.2.1`，按下「安裝」。
4. 之後開啟符合 `https://inline.app/*` 的頁面，腳本會自動載入。新版包含 `@updateURL` 與 `@downloadURL`，後續可由 Tampermonkey 檢查更新。

### 步驟二：開啟目標餐廳訂位頁面
1. 使用 Chrome / Edge 等瀏覽器開啟您想預約的**店家專屬訂位頁面**（網址開頭需為 `https://inline.app/booking/...`）。
> [!NOTE]
> 請勿留在 `dining.inline.app/.../discover/...` 餐廳目錄總覽頁，需點進餐廳卡片的「**訂位 ↗**」專屬頁面。

### 步驟三：設定搶位參數
面板將自動載入或輸入您的預約條件：

| 參數名稱 | 設定範例 | 說明 |
| :--- | :--- | :--- |
| **搶位模式** | `準時放位開搶` / `釋出撿漏輪詢` | 放位開搶適合搶凌晨或中午整點新開放日期；撿漏輪詢適合監控已訂滿日期。 |
| **目標日期** | `2026-09-20` | 欲預約用餐的日期（格式：YYYY-MM-DD）。 |
| **放位時間** | `00:00:00` 或 `12:00:00` | 店家開放訂位的系統時間（準時放位模式專用）。 |
| **提前放位毫秒** | `180` | 提前觸發時間補償（Lead Time Ms），抵銷網路延遲。 |
| **大人 / 小孩人數**| `2 位 / 0 位` | 用餐人數設定。 |
| **優先時段清單** | `17:30, 18:00, 19:00` | 依志願順序以逗點隔開，越前面越優先搶取。 |
| **桌型偏好** | `板前吧台` 或 留空 | 指定偏好桌型；留空則預設自動選取第一個可用桌型。 |
| **訂位人姓名** | `王大明` | 支援單姓、複姓（歐陽）與英文名，自動拆解姓與名。 |
| **稱謂** | `先生` / `小姐` / `其他` | 自動點選對應性別稱謂單選框。 |
| **電話號碼** | `0912345678` | 訂位手機號碼（需能接收簡訊確認通知）。 |
| **Email** | `user@example.com` | 接收訂位確認信之電子信箱。 |
| **用餐目的 / 備註**| `慶生` / `靠窗` | 可選，特殊需求備註。 |
| **免訂金確認** | `自動` | 當預約無須預收信用卡保證金時，固定全自動點擊「確認訂位」。 |
| **鈴聲通知** | `勾選` | 搶位成功或遇到需手動輸入信用卡時發出音效提示。 |

設定完成後點擊「**💾 儲存設定**」，瀏覽器將自動記錄您的偏好設定；之後由 Tampermonkey 自動載入 userscript 時無須重新填寫。

### 步驟四：啟動搶位
- 點擊「**🚀 啟動搶位**」按鈕。
- 面板狀態將轉為「等待開搶」並顯示精準倒數。搶位成功時將響起提示鈴聲並彈出系統通知！
- 在「釋出撿漏」模式中，沒有空位或日期仍反白時會顯示重新整理倒數。重新整理後應看到 `♻️ Tampermonkey 已自動恢復釋出撿漏`。
- 按下「**⏹️ 停止**」會清除持久化執行狀態，之後重新整理不會再自動啟動。

> [!WARNING]
> Console 貼上版在重新整理後會消失，因此不能用於新版的可恢復式釋出撿漏；若只做單次準時放位或開發測試，仍可手動貼上執行。



---

## 🛡️ 反爬蟲與風控應對指南 (Anti-bot Strategy)

Inline 採用全球頂級防護系統 **PerimeterX (HUMAN Security)**。實戰中建議採取以下最佳人機協同策略：

1. **提前領取通行證（核心技巧）**：在開搶前 3~5 分鐘（如 11:55），手動在畫面上點選日期或人數。若跳出「按壓不放確認是人類」驗證，**提前用手按住 3 秒解開**，取得長達 30 分鐘的 `_px3` 通行權杖。正式開搶時將一路暢通！
2. **開搶前滑鼠暖身**：開搶前 30 秒手動晃動滑鼠與滾動頁面，模擬真實人類微震顫行為。
3. **乾淨網路環境**：建議使用手機 4G/5G 熱點或家用寬頻，避免使用公司公用 Wi-Fi 或 VPN。
4. **蜂鳴警報與秒級接管**：若開搶時不幸遭遇驗證，助手會立即發出高頻警報，人工按壓通過後的 100ms 內，助手將自動無縫接手完成後續訂位。

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

- 📘 **[完整使用者操作手冊 (USER_GUIDE.md)](./USER_GUIDE.md)**：包含 v2.2.1 Tampermonkey userscript 安裝、參數設定、實戰人機協同與對抗 PerimeterX 按壓防護的完整教學指南。
- 📖 **[領域模型規範 (CONTEXT.md)](./CONTEXT.md)**：定義本系統之領域術語（Reservation, Priority Slot List, Table Category, Deposit Policy 等）。
- 🏛️ **[ADR 0001: Adopt Tampermonkey Userscript Architecture](./docs/adr/0001-userscript-architecture.md)**：說明採用本機油猴腳本而非外部 CDP 腳本以規避 PerimeterX 的架構決策。
- 🏛️ **[ADR 0002: Soft Re-triggering Over Full Page Reload](./docs/adr/0002-soft-retrigger-over-full-reload.md)**：說明開搶時採用毫秒級軟刷新機制以將延遲降至最低的考量。
- 🏛️ **[ADR 0003: Deep DOM Adapter Seam with Automated Tests](./docs/adr/0003-extract-deep-dom-adapter.md)**：說明透過 ReservationTarget 縫隙隔離 DOM 與測試架構的設計模式。

---

## ⚖️ 免責聲明 (Disclaimer)

本專案僅供程式技術研究、自動化測試與個人合法預訂使用。請遵守目標網站的服務條款，切勿用於任何商業轉售或惡意破壞行為。
