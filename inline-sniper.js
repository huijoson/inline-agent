// ==UserScript==
// @name         Inline 餐廳自動搶位助手 (Inline Booking Sniper)
// @namespace    https://github.com/inline-agent
// @version      2.2.1
// @description  支援準時放位與 Tampermonkey 可恢復式釋出撿漏，自動校時、重新整理查詢、秒選時段、填表與送出。
// @author       Antigravity
// @homepageURL  https://github.com/huijoson/inline-agent
// @supportURL   https://github.com/huijoson/inline-agent/issues
// @updateURL    https://raw.githubusercontent.com/huijoson/inline-agent/main/inline-reservation-bot.user.js
// @downloadURL  https://raw.githubusercontent.com/huijoson/inline-agent/main/inline-reservation-bot.user.js
// @match        https://inline.app/*
// @match        https://*.inline.app/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ==========================================
  // 1. 常數與預設設定
  // ==========================================
  const STORAGE_KEY = 'INLINE_SNIPER_CONFIG_V1';
  const RUNTIME_STORAGE_KEY = 'INLINE_SNIPER_RUNTIME_V1';
  const CancellationPhase = Object.freeze({
    MONITORING: 'monitoring',
    SUBMITTING: 'submitting',
  });
  const INACTIVE_RUNTIME_STATE = Object.freeze({
    active: false,
    mode: null,
    bookingTarget: '',
    phase: null,
  });

  function createRuntimeStateStore(storage, key = RUNTIME_STORAGE_KEY) {
    function load() {
      try {
        const parsed = JSON.parse(storage?.getItem(key) || 'null');
        if (
          !parsed ||
          parsed.active !== true ||
          parsed.mode !== 'cancellation' ||
          !parsed.bookingTarget
        ) {
          return { ...INACTIVE_RUNTIME_STATE };
        }
        return {
          active: true,
          mode: 'cancellation',
          bookingTarget: String(parsed.bookingTarget),
          phase: parsed.phase === CancellationPhase.SUBMITTING
            ? CancellationPhase.SUBMITTING
            : CancellationPhase.MONITORING,
        };
      } catch (e) {
        return { ...INACTIVE_RUNTIME_STATE };
      }
    }

    return {
      load,
      activate(bookingTarget, phase = CancellationPhase.MONITORING) {
        if (!storage || !bookingTarget) return false;
        try {
          storage.setItem(key, JSON.stringify({
            active: true,
            mode: 'cancellation',
            bookingTarget: String(bookingTarget),
            phase: phase === CancellationPhase.SUBMITTING
              ? CancellationPhase.SUBMITTING
              : CancellationPhase.MONITORING,
          }));
          return true;
        } catch (e) {
          return false;
        }
      },
      deactivate() {
        if (!storage) return false;
        try {
          storage.removeItem(key);
          return true;
        } catch (e) {
          return false;
        }
      },
      shouldResume(bookingTarget) {
        const saved = load();
        return saved.active && saved.bookingTarget === bookingTarget;
      },
    };
  }

  function resumePersistedCancellation({
    store,
    bookingTarget,
    mode,
    start,
    logger = () => {},
  }) {
    if (
      mode !== 'cancellation' ||
      !store ||
      !store.shouldResume(bookingTarget) ||
      typeof start !== 'function'
    ) {
      return false;
    }

    const persisted = store.load();
    if (start({ phase: persisted.phase }) === false) return false;
    logger('♻️ Tampermonkey 已自動恢復釋出撿漏');
    return true;
  }

  function getBrowserLocalStorage() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (e) {
      return null;
    }
  }

  async function clearSiteCacheWithSnipingStopped({ stopSniping, clearStorage }) {
    stopSniping();
    return clearStorage();
  }

  const DEFAULT_CONFIG = {
    enabled: false,
    mode: 'drop', // 'drop' (準時放位開搶) | 'cancellation' (撿漏輪詢)
    targetDate: '', // YYYY-MM-DD
    adults: '2',
    kids: '0',
    tablePreference: '', // 留空為預設選第一個可用桌型，亦可設定 '一般, 板前吧台' 等
    prioritySlots: '18:30, 19:00, 19:30, 18:00, 20:00', // 逗點分隔優先時段
    dropTime: '00:00:00', // 開搶時間 (HH:mm:ss)
    leadTimeMs: 180, // 開搶前提前觸發毫秒數
    pollIntervalMin: 3000, // 撿漏輪詢最小間隔 (ms)
    pollIntervalMax: 5500, // 撿漏輪詢最大間隔 (ms)
    userName: '',
    userPhone: '',
    userEmail: '',
    userGender: 'male', // 'male' | 'female'
    bookingNote: '',
    soundAlert: true,
    desktopNotification: true,
  };

  // 狀態運行時變數
  const state = {
    serverTimeOffsetMs: 0, // 伺服器時間 - 本機時間
    isRunning: false,
    timerId: null,
    pollTimeoutId: null,
    logHistory: [],
    captchaAlerted: false,
  };

  // 讀取/儲存設定
  function loadConfig() {
    try {
      if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG };
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : { ...DEFAULT_CONFIG };
    } catch (e) {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(cfg) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {
      console.error('儲存設定失敗', e);
    }
  }

  let config = loadConfig();

  const runtimeStateStore = createRuntimeStateStore(getBrowserLocalStorage());

  function getCurrentBookingTarget() {
    if (typeof window === 'undefined' || !window.location) return '';
    return `${window.location.origin}${window.location.pathname}${window.location.search}`;
  }

  // ==========================================
  // 2. 音效與系統通知模組 (Web Audio & Notification)
  // ==========================================
  function playSuccessSound() {
    if (typeof window === 'undefined' || !config.soundAlert) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      // 產生三音階慶祝提示音 (C5 -> E5 -> G5)
      const freqs = [523.25, 659.25, 783.99, 1046.5];
      freqs.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + index * 0.12);
        gain.gain.setValueAtTime(0.3, now + index * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.12 + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + index * 0.12);
        osc.stop(now + index * 0.12 + 0.35);
      });
    } catch (err) {
      console.warn('音效播放失敗', err);
    }
  }

  function playAlertSound() {
    if (typeof window === 'undefined' || !config.soundAlert) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      [880, 440, 880, 440].forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now + index * 0.14);
        gain.gain.setValueAtTime(0.35, now + index * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.14 + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + index * 0.14);
        osc.stop(now + index * 0.14 + 0.13);
      });
    } catch (e) {}
  }

  function checkCaptchaAlert() {
    const isCaptcha =
      !!document.querySelector('#px-captcha, #px-captcha-wrapper') ||
      (document.body && /按壓不放以確認您是人類|Press & Hold/i.test(document.body.innerText));

    if (isCaptcha && !state.captchaAlerted) {
      state.captchaAlerted = true;
      addLog('🚨 偵測到 PerimeterX 按壓驗證！請立即用滑鼠按住畫面按鈕 3 秒！');
      playAlertSound();
      showNotification('🚨 請立即按壓驗證', '畫面出現真人驗證，請按住 3 秒，通過後助手會自動接手！');
    } else if (!isCaptcha) {
      state.captchaAlerted = false;
    }
  }

  function showNotification(title, message) {
    if (!config.desktopNotification) return;
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(title, { body: message, icon: 'https://inline.app/favicon.ico' });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') {
            new Notification(title, { body: message, icon: 'https://inline.app/favicon.ico' });
          }
        });
      }
    }
  }

  // ==========================================
  // 3. 伺服器時間校正模組 (Server Time Calibration)
  // ==========================================
  async function syncServerTime() {
    try {
      const t0 = performance.now();
      const res = await fetch(window.location.href, { method: 'HEAD', cache: 'no-store' });
      const t1 = performance.now();
      const dateHeader = res.headers.get('date');
      if (dateHeader) {
        const serverDate = new Date(dateHeader).getTime();
        const roundTrip = (t1 - t0) / 2;
        const estimatedServerNow = serverDate + roundTrip;
        state.serverTimeOffsetMs = estimatedServerNow - Date.now();
        addLog(`⏱️ 伺服器對時完成，時間偏移值 (Offset): ${state.serverTimeOffsetMs > 0 ? '+' : ''}${Math.round(state.serverTimeOffsetMs)} ms`);
      }
    } catch (e) {
      addLog('⚠️ 伺服器對時失敗，將使用本機時間');
      state.serverTimeOffsetMs = 0;
    }
  }

  function getSyncedNow() {
    return Date.now() + state.serverTimeOffsetMs;
  }

  // ==========================================
  // 4. UI 控制面板與日誌系統 (Floating Control Panel)
  // ==========================================
  function addLog(msg) {
    const timeStr = new Date(getSyncedNow()).toTimeString().split(' ')[0];
    const line = `[${timeStr}] ${msg}`;
    console.log(`[InlineSniper] ${line}`);
    state.logHistory.unshift(line);
    if (state.logHistory.length > 50) state.logHistory.pop();

    const logBox = document.getElementById('ias-log-box');
    if (logBox) {
      logBox.innerHTML = state.logHistory.join('<br>');
    }
  }

  function isBookingPage() {
    return (
      window.location.pathname.includes('/booking/') ||
      window.location.pathname.includes('/branch/') ||
      !!document.querySelector('#date-picker, input#name, button.time-slot, form[action*="booking"]')
    );
  }

  function createFloatingPanel() {
    const existing = document.getElementById('inline-auto-sniper-panel');
    if (existing) {
      try { existing.remove(); } catch (e) {}
    }

    const container = document.createElement('div');
    container.id = 'inline-auto-sniper-panel';
    container.innerHTML = `
      <style>
        #inline-auto-sniper-panel {
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", sans-serif;
          color: #333;
        }
        #ias-toggle-btn {
          background: linear-gradient(135deg, #ff4b2b, #ff416c);
          color: #fff;
          border: none;
          border-radius: 28px;
          padding: 10px 18px;
          font-size: 14px;
          font-weight: 600;
          box-shadow: 0 4px 14px rgba(255, 65, 108, 0.4);
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        #ias-toggle-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 18px rgba(255, 65, 108, 0.5);
        }
        #ias-main-card {
          display: none;
          position: absolute;
          bottom: 50px;
          right: 0;
          width: 360px;
          background: rgba(255, 255, 255, 0.96);
          backdrop-filter: blur(12px);
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
          border: 1px solid rgba(220, 220, 220, 0.8);
          overflow: hidden;
          animation: iasFadeIn 0.25s ease-out;
        }
        @keyframes iasFadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .ias-header {
          background: #1e293b;
          color: #fff;
          padding: 12px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 600;
          font-size: 15px;
        }
        .ias-body {
          padding: 14px 16px;
          max-height: 480px;
          overflow-y: auto;
          font-size: 13px;
        }
        .ias-group {
          margin-bottom: 12px;
        }
        .ias-group label {
          display: block;
          font-weight: 600;
          margin-bottom: 4px;
          color: #475569;
        }
        .ias-group input, .ias-group select {
          width: 100%;
          padding: 7px 10px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          font-size: 13px;
          box-sizing: border-box;
          background: #fff;
        }
        .ias-row {
          display: flex;
          gap: 10px;
        }
        .ias-row > div {
          flex: 1;
        }
        .ias-btn-row {
          display: flex;
          gap: 10px;
          margin-top: 14px;
        }
        .ias-btn {
          flex: 1;
          padding: 9px;
          border-radius: 8px;
          font-weight: 600;
          border: none;
          cursor: pointer;
          font-size: 13px;
          transition: background 0.2s;
        }
        .ias-btn-start {
          background: #10b981;
          color: #fff;
        }
        .ias-btn-start:hover { background: #059669; }
        .ias-btn-stop {
          background: #ef4444;
          color: #fff;
        }
        .ias-btn-stop:hover { background: #dc2626; }
        .ias-btn-save {
          background: #3b82f6;
          color: #fff;
        }
        .ias-btn-save:hover { background: #2563eb; }
        #ias-status-banner {
          background: #f1f5f9;
          padding: 8px 12px;
          border-radius: 8px;
          margin-bottom: 12px;
          font-weight: 600;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        #ias-countdown {
          font-family: monospace;
          color: #e11d48;
          font-weight: 700;
        }
        #ias-log-box {
          background: #0f172a;
          color: #38bdf8;
          padding: 8px;
          border-radius: 8px;
          font-family: monospace;
          font-size: 11px;
          height: 90px;
          overflow-y: auto;
          line-height: 1.4;
          word-break: break-all;
        }
      </style>

      <button id="ias-toggle-btn">⚡ Inline 搶位助手</button>

      <div id="ias-main-card">
        <div class="ias-header">
          <span>⚡ Inline 搶位設定台</span>
          <span id="ias-close-btn" style="cursor: pointer; font-size: 18px;">&times;</span>
        </div>
        <div class="ias-body">
          <div id="ias-status-banner">
            <span id="ias-status-text">🔴 待命</span>
            <span id="ias-countdown">--:--:--</span>
          </div>

          <div id="ias-page-tip" style="${isBookingPage() ? 'display: none;' : 'display: block;'} background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; padding: 10px; border-radius: 8px; font-size: 12px; margin-bottom: 12px; line-height: 1.5;">
            📍 <b>目前在探索目錄頁</b><br>
            請點選本頁任一餐廳的「<b>訂位 &#8599;</b>」進入專屬訂位頁面。您可先在下方填妥訂位人個資與偏好時段，並點擊「💾 儲存設定」！
          </div>

          <div class="ias-group">
            <label>搶位模式 (Mode)</label>
            <select id="ias-mode">
              <option value="drop" ${config.mode === 'drop' ? 'selected' : ''}>準時放位開搶 (Opening Drop)</option>
              <option value="cancellation" ${config.mode === 'cancellation' ? 'selected' : ''}>釋出撿漏輪詢 (Cancellation Sniping)</option>
            </select>
          </div>

          <div class="ias-row ias-group">
            <div>
              <label>目標日期 (YYYY-MM-DD)</label>
              <input type="date" id="ias-target-date" value="${config.targetDate || ''}">
            </div>
            <div>
              <label>放位時間 (HH:mm:ss)</label>
              <input type="text" id="ias-drop-time" value="${config.dropTime || '00:00:00'}" placeholder="00:00:00">
            </div>
          </div>

          <div class="ias-row ias-group">
            <div>
              <label>大人 (Adults)</label>
              <select id="ias-adults">
                ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<option value="${n}" ${config.adults == n ? 'selected' : ''}>${n} 位</option>`).join('')}
              </select>
            </div>
            <div>
              <label>小孩 (Kids)</label>
              <select id="ias-kids">
                ${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${config.kids == n ? 'selected' : ''}>${n} 位</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="ias-group">
            <label>桌型偏好 (留空則自動選首個可用桌型，亦可填: 一般, 板前吧台)</label>
            <input type="text" id="ias-table-preference" value="${config.tablePreference || ''}" placeholder="不拘 (預設自動秒選第一個可用桌型)">
          </div>

          <div class="ias-group">
            <label>優先時段清單 (以逗點隔開，越前越優先)</label>
            <input type="text" id="ias-priority-slots" value="${config.prioritySlots}" placeholder="19:00, 19:30, 18:30">
          </div>

          <div class="ias-row ias-group">
            <div>
              <label>訂位姓名</label>
              <input type="text" id="ias-user-name" value="${config.userName}" placeholder="王大明">
            </div>
            <div>
              <label>稱謂</label>
              <select id="ias-user-gender">
                <option value="male" ${config.userGender === 'male' ? 'selected' : ''}>先生</option>
                <option value="female" ${config.userGender === 'female' ? 'selected' : ''}>小姐</option>
              </select>
            </div>
          </div>

          <div class="ias-row ias-group">
            <div>
              <label>電話</label>
              <input type="tel" id="ias-user-phone" value="${config.userPhone}" placeholder="0912345678">
            </div>
            <div>
              <label>Email</label>
              <input type="email" id="ias-user-email" value="${config.userEmail}" placeholder="user@gmail.com">
            </div>
          </div>

          <div class="ias-group">
            <label>備註需求 (可選)</label>
            <input type="text" id="ias-booking-note" value="${config.bookingNote}" placeholder="慶生 / 靠窗">
          </div>

          <div class="ias-group" style="display: flex; gap: 12px; margin-top: 6px;">
            <label style="display: inline-flex; align-items: center; gap: 4px; font-weight: normal; cursor: pointer;">
              <input type="checkbox" id="ias-sound" ${config.soundAlert ? 'checked' : ''}> 鈴聲通知
            </label>
          </div>

          <div class="ias-btn-row">
            <button class="ias-btn ias-btn-save" id="ias-btn-save" title="儲存當前搶位偏好設定">💾 儲存</button>
            <button class="ias-btn" id="ias-btn-clear" title="清除網站 LocalStorage、SessionStorage 與瀏覽器快取" style="background: #64748b; color: #fff;">🧹 清除快取</button>
            <button class="ias-btn ias-btn-start" id="ias-btn-start">🚀 啟動搶位</button>
            <button class="ias-btn ias-btn-stop" id="ias-btn-stop" style="display: none;">⏹️ 停止</button>
          </div>

          <div class="ias-group" style="margin-top: 12px;">
            <label>即時日誌 (Log)</label>
            <div id="ias-log-box"></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(container);
    // 於瀏覽器主控台 (Console) 貼上執行時，預設直接展開控制面板
    const mainCard = document.getElementById('ias-main-card');
    if (mainCard) mainCard.style.display = 'block';

    bindPanelEvents();
    syncServerTime();
  }

  function bindPanelEvents() {
    const toggleBtn = document.getElementById('ias-toggle-btn');
    const mainCard = document.getElementById('ias-main-card');
    const closeBtn = document.getElementById('ias-close-btn');
    const saveBtn = document.getElementById('ias-btn-save');
    const clearBtn = document.getElementById('ias-btn-clear');
    const startBtn = document.getElementById('ias-btn-start');
    const stopBtn = document.getElementById('ias-btn-stop');

    toggleBtn.addEventListener('click', () => {
      mainCard.style.display = mainCard.style.display === 'none' || !mainCard.style.display ? 'block' : 'none';
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    });

    closeBtn.addEventListener('click', () => {
      mainCard.style.display = 'none';
    });

    saveBtn.addEventListener('click', () => {
      readInputsToConfig();
      saveConfig(config);
      addLog('✅ 設定已儲存至瀏覽器');
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        const savedConfig = loadConfig();
        try {
          await clearSiteCacheWithSnipingStopped({
            stopSniping: stopSniper,
            clearStorage: async () => {
              if (typeof sessionStorage !== 'undefined') {
                sessionStorage.clear();
              }
              if (typeof localStorage !== 'undefined') {
                localStorage.clear();
                saveConfig(savedConfig);
              }
              if (typeof caches !== 'undefined') {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
              }
              if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
                try {
                  const dbs = await indexedDB.databases();
                  dbs.forEach((db) => {
                    if (db.name) indexedDB.deleteDatabase(db.name);
                  });
                } catch (e) {}
              }
            },
          });
          addLog('🧹 已成功清空 inline 網站快取與 Session 記錄！（搶位設定已自動保留）');
          alert('【快取清除成功】\n已成功清除該 inline 網站所有 LocalStorage、SessionStorage 與快取數據！\n\n（您的搶位設定已安全保留）');
        } catch (err) {
          addLog(`⚠️ 清除快取時發生異常: ${err?.message || err}`);
        }
      });
    }

    startBtn.addEventListener('click', () => {
      readInputsToConfig();
      saveConfig(config);

      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }

      if (!isBookingPage()) {
        addLog('⚠️ 目前處於餐廳探索列表頁，請先點選想預約的餐廳「訂位 ↗」進入訂位頁後再啟動搶位！');
        alert('【提醒】您目前在餐廳探索/推薦目錄頁，尚未進入任何店家的訂位頁面。\n\n請先在網頁中點選您想預約的餐廳「訂位 ↗」按鈕，進入專屬訂位頁面後再點擊啟動搶位！');
        return;
      }

      startSniper();
    });

    stopBtn.addEventListener('click', () => {
      stopSniper();
    });
  }

  function readInputsToConfig() {
    config.mode = document.getElementById('ias-mode').value;
    config.targetDate = document.getElementById('ias-target-date').value;
    config.dropTime = document.getElementById('ias-drop-time').value.trim();
    config.adults = document.getElementById('ias-adults').value;
    config.kids = document.getElementById('ias-kids').value;
    config.tablePreference = (document.getElementById('ias-table-preference')?.value || '').trim();
    config.prioritySlots = document.getElementById('ias-priority-slots').value;
    config.userName = document.getElementById('ias-user-name').value.trim();
    config.userGender = document.getElementById('ias-user-gender').value;
    config.userPhone = document.getElementById('ias-user-phone').value.trim();
    config.userEmail = document.getElementById('ias-user-email').value.trim();
    config.bookingNote = document.getElementById('ias-booking-note').value.trim();
    config.soundAlert = document.getElementById('ias-sound').checked;
  }

  function updateStatusUI(statusText, countdownText, isRunning) {
    if (typeof document === 'undefined') return;
    const statusEl = document.getElementById('ias-status-text');
    const countdownEl = document.getElementById('ias-countdown');
    const startBtn = document.getElementById('ias-btn-start');
    const stopBtn = document.getElementById('ias-btn-stop');

    if (statusEl) statusEl.innerText = statusText;
    if (countdownEl) countdownEl.innerText = countdownText;
    if (startBtn && stopBtn) {
      startBtn.style.display = isRunning ? 'none' : 'block';
      stopBtn.style.display = isRunning ? 'block' : 'none';
    }
  }

  // ==========================================
  // 5. 預訂目標轉接器模組 (InlineDomAdapter)
  // 依據 ADR-0003 實作 ReservationTarget 縫隙，深層封裝所有 DOM 查詢與 React 原型鏈描述符覆寫
  // ==========================================
  function createInlineDomAdapter(deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    const log = deps.logger || (typeof addLog === 'function' ? addLog : console.log);
    const reload = deps.reload || (() => {
      if (typeof window === 'undefined' || !window.location) return false;
      window.location.reload();
      return true;
    });

    function isElementClickable(el) {
      if (!el || el.disabled || (el.classList && el.classList.contains('disabled'))) return false;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
      return el.offsetParent !== null;
    }

    function splitPersonName(fullName) {
      const name = String(fullName || '').trim();
      if (!name) return { familyName: '', givenName: '' };

      if (name.includes(' ')) {
        const parts = name.split(/\s+/);
        if (parts.length === 2) {
          if (/^[a-zA-Z]+$/.test(parts[0]) && /^[a-zA-Z]+$/.test(parts[1])) {
            return { familyName: parts[1], givenName: parts[0] };
          }
          return { familyName: parts[0], givenName: parts[1] };
        }
      }

      const compoundSurnames = [
        '歐陽', '司馬', '上官', '諸葛', '夏侯', '東方', '皇甫', '尉遲', '公孫',
        '令狐', '端木', '司徒', '南宮', '萬俟', '聞人', '慕容', '司空'
      ];
      for (const cs of compoundSurnames) {
        if (name.startsWith(cs) && name.length > 2) {
          return {
            familyName: cs,
            givenName: name.slice(cs.length),
          };
        }
      }

      if (name.length >= 2) {
        return {
          familyName: name.slice(0, 1),
          givenName: name.slice(1),
        };
      }

      return {
        familyName: name,
        givenName: name,
      };
    }

    function setReactValue(element, val) {
      if (!element || val === undefined || val === null || val === '') return;
      try {
        const isTextarea = element.tagName === 'TEXTAREA';
        const win = (typeof window !== 'undefined' ? window : null);
        const proto = isTextarea
          ? (win && win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : Object.getPrototypeOf(element))
          : (win && win.HTMLInputElement ? win.HTMLInputElement.prototype : Object.getPrototypeOf(element));
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');

        // 1. 重設 React 的內部 ValueTracker，以防 React 16/17/18 忽略 input 事件
        const tracker = element._valueTracker;
        if (tracker) {
          tracker.setValue('');
        }

        // 2. 透過原生原型鏈 descriptor 設定值
        if (descriptor && descriptor.set) {
          descriptor.set.call(element, val);
        } else {
          element.value = val;
        }

        // 3. 依序觸發 input, change, blur 事件（支援 bubbles 與 composed）
        if (typeof Event === 'function') {
          const inputEvent = typeof InputEvent === 'function'
            ? new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: String(val) })
            : new Event('input', { bubbles: true, composed: true });
          element.dispatchEvent(inputEvent);

          const changeEvent = new Event('change', { bubbles: true, composed: true });
          element.dispatchEvent(changeEvent);

          const blurEvent = new Event('blur', { bubbles: true, composed: true });
          element.dispatchEvent(blurEvent);
        }
      } catch (e) {
        try {
          element.value = val;
          if (typeof Event === 'function') {
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } catch (err) {}
      }
    }

    function findClickableButton(textRegex, excludeRegex = null) {
      if (!doc) return null;
      const candidates = Array.from(
        doc.querySelectorAll('button, a, div[role="button"], input[type="button"], input[type="submit"], span[role="button"]')
      );
      return candidates.find((btn) => {
        if (!isElementClickable(btn)) return false;
        const txt = (btn.innerText || btn.value || '').trim();
        if (!textRegex.test(txt)) return false;
        if (excludeRegex && excludeRegex.test(txt)) return false;
        return true;
      });
    }

    return {
      reloadPage() {
        try {
          return reload() !== false;
        } catch (e) {
          console.warn('[InlineSniper] reloadPage 異常', e);
          return false;
        }
      },

      acknowledgeHouseRules() {
        if (!doc) return false;
        let handled = false;
        try {
          const allCheckboxes = Array.from(
            doc.querySelectorAll('input[type="checkbox"], [role="checkbox"]')
          );
          allCheckboxes.forEach((cb) => {
            const parentText = (cb.closest('label, div, p, li')?.innerText || '').trim();
            const isRuleCheckbox = /我已閱讀|同意規則|注意事項|同意並閱讀|服務條款|我同意/i.test(parentText);
            if (isRuleCheckbox) {
              if (cb.type === 'checkbox' && !cb.checked && !cb.disabled) {
                cb.click();
                handled = true;
                log('📋 自動勾選：我已閱讀並同意規則與注意事項');
              } else if (cb.getAttribute && (cb.getAttribute('aria-checked') === 'false' || cb.getAttribute('data-state') === 'unchecked')) {
                cb.click();
                handled = true;
                log('📋 自動勾選條款核取方塊');
              }
            }
          });

          const confirmBtn = findClickableButton(
            /我已閱讀並同意|我同意|我知道了|同意並繼續|繼續訂位|同意|我知道|確定|繼續|OK|Agree/i,
            /取消|不同意|Close/i
          );

          if (confirmBtn) {
            confirmBtn.click();
            log(`📋 自動點擊確認須知：${confirmBtn.innerText.trim()}`);
            return true;
          }
        } catch (e) {
          console.warn('[InlineSniper] acknowledgeHouseRules 異常', e);
        }
        return handled;
      },

      setPartySize(adults, kids) {
        if (!doc) return;
        try {
          const adultsStr = String(adults);
          const kidsStr = String(kids);
          const adultPicker = doc.getElementById('adult-picker') || doc.querySelector('select[name="adult"]');
          if (adultPicker && adultPicker.value !== adultsStr) {
            adultPicker.value = adultsStr;
            if (typeof Event === 'function') {
              adultPicker.dispatchEvent(new Event('change', { bubbles: true }));
            }
            log(`👥 設定大人人數: ${adultsStr}`);
          }

          const kidPicker = doc.getElementById('kid-picker') || doc.querySelector('select[name="kid"]');
          if (kidPicker && kidPicker.value !== kidsStr) {
            kidPicker.value = kidsStr;
            if (typeof Event === 'function') {
              kidPicker.dispatchEvent(new Event('change', { bubbles: true }));
            }
            log(`👶 設定小孩人數: ${kidsStr}`);
          }
        } catch (e) {
          console.warn('[InlineSniper] setPartySize 異常', e);
        }
      },

      selectDate(targetDate) {
        if (!doc || !targetDate) return true;
        try {
          const targetDateFormatted = targetDate.replace(/-/g, '');

          const selectedDateSummary = doc.querySelector('[data-cy="target-date"]');
          const selectedDateText = (selectedDateSummary?.innerText || selectedDateSummary?.textContent || '').trim();
          const selectedDateMatch = selectedDateText.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
          const confirmedDate = selectedDateMatch
            ? `${selectedDateMatch[1]}-${selectedDateMatch[2].padStart(2, '0')}-${selectedDateMatch[3].padStart(2, '0')}`
            : '';

          if (confirmedDate === targetDate) {
            log(`📅 目標日期已確認: ${targetDate}`);
            return true;
          }

          const datePicker = doc.getElementById('date-picker') || doc.querySelector('[data-cy="date-picker"]');
          if (
            datePicker &&
            datePicker.getAttribute?.('aria-expanded') === 'false' &&
            isElementClickable(datePicker)
          ) {
            datePicker.click();
            log(`📅 已展開用餐日期選單，準備選取: ${targetDate}`);
            return false;
          }

          const findDateEl = () => {
            const dayElements = Array.from(doc.querySelectorAll('[data-date], button[data-date], div[data-date], button, div[role="button"]'));
            return dayElements.find((el) => {
              const dataDate = (el.getAttribute && el.getAttribute('data-date')) || '';
              return dataDate === targetDate || dataDate.replace(/-/g, '') === targetDateFormatted;
            });
          };

          let matchDateEl = findDateEl();

          // 若目前畫面上尚未出現該目標日期（例如為跨月份日期），自動尋找並點擊日曆「下一頁/下個月」按鈕
          if (!matchDateEl) {
            const nextBtns = Array.from(
              doc.querySelectorAll('#calendar-picker button, [data-cy="calendar-picker"] button, button[aria-label*="next" i], button[aria-label*="Next" i], [aria-label*="下個月"], [data-cy*="next-month"]')
            );
            const nextBtn = nextBtns.find((btn) => {
              const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
              const txt = (btn.innerText || '').toLowerCase();
              return aria.includes('next') || aria.includes('下') || txt.includes('>') || txt.includes('下') || btn.querySelector('svg');
            }) || nextBtns[nextBtns.length - 1];

            if (nextBtn && isElementClickable(nextBtn)) {
              for (let i = 0; i < 4; i++) {
                nextBtn.click();
                matchDateEl = findDateEl();
                if (matchDateEl) break;
              }
            }
          }

          if (matchDateEl?.getAttribute?.('aria-selected') === 'true') {
            log(`📅 目標日期已選取: ${targetDate}`);
            return true;
          }

          if (matchDateEl && isElementClickable(matchDateEl)) {
            matchDateEl.click();
            log(`📅 已點擊目標日期，等待頁面完成切換: ${targetDate}`);
            return false;
          }
        } catch (e) {
          console.warn('[InlineSniper] selectDate 異常', e);
        }
        return false;
      },

      selectTableType(preferredTypes = []) {
        if (!doc) return null;
        try {
          const tableButtons = Array.from(
            doc.querySelectorAll('button[data-cy^="table-tag-"], [data-cy="table-tag-selector"] button, #table-tag-selector button, #table-tag-selector [role="button"], button[data-testid]')
          ).filter((btn) => {
            if (!isElementClickable(btn)) return false;
            const txt = (btn.innerText || btn.value || '').trim();
            if (!txt || /\b\d{1,2}:\d{2}\b/.test(txt)) return false;
            const isFull = (btn.classList && (btn.classList.contains('full') || btn.classList.contains('disabled'))) ||
              btn.disabled || btn.getAttribute('aria-disabled') === 'true' || txt.includes('滿') || txt.includes('full');
            return !isFull;
          });

          if (tableButtons.length === 0) return null;

          const prefs = Array.isArray(preferredTypes)
            ? preferredTypes.map((s) => s.trim()).filter(Boolean)
            : String(preferredTypes || '').split(',').map((s) => s.trim()).filter(Boolean);

          // 1. 優先比對指定桌型清單 (支援模糊語意與字序相容，例如「板前吧台」可相容「吧台板前」或「板前座位（吧台座位）」)
          if (prefs.length > 0) {
            const normalize = (s) => String(s || '').toLowerCase().replace(/檯/g, '台').replace(/[（）()、，,\s_-]/g, '');
            const coreKeywords = ['板前', '吧台', '一般', '包廂', '戶外', '靠窗', '沙發', '高腳', '方桌', '圓桌'];

            for (const pref of prefs) {
              const normPref = normalize(pref);
              if (!normPref) continue;

              const match = tableButtons.find((btn) => {
                const txt = (btn.innerText || btn.value || '').trim();
                const testId = (btn.getAttribute && btn.getAttribute('data-testid')) || '';
                const cy = (btn.getAttribute && btn.getAttribute('data-cy')) || '';
                const normTxt = normalize(txt);
                const normTestId = normalize(testId);
                const normCy = normalize(cy);

                // 直接/雙向子字串包含
                if (normTxt.includes(normPref) || normPref.includes(normTxt)) return true;
                if (normTestId.includes(normPref) || normCy.includes(normPref)) return true;

                // 核心關鍵字交集匹配 (解決 高雄「吧台板前」 vs 桃園「板前吧台」等倒裝字序問題)
                const hasSharedKeyword = coreKeywords.some((kw) => normPref.includes(kw) && normTxt.includes(kw));
                return hasSharedKeyword;
              });

              if (match) {
                const selectedName = (match.innerText || match.value || pref).trim();
                match.click();
                log(`🪑 成功鎖定用餐桌型: 【${selectedName}】`);
                return selectedName;
              }
            }
          }

          // 2. 預設策略：自動選取首個可用桌型
          const firstAvailable = tableButtons[0];
          if (firstAvailable) {
            const selectedName = (firstAvailable.innerText || firstAvailable.value || '預設桌型').trim();
            firstAvailable.click();
            log(`🪑 自動選取首個可用桌型: 【${selectedName}】`);
            return selectedName;
          }
        } catch (e) {
          console.warn('[InlineSniper] selectTableType 異常', e);
        }
        return null;
      },

      claimSlot(priorityList) {
        if (!doc || !priorityList) return null;
        try {
          const slotButtons = Array.from(
            doc.querySelectorAll('button.time-slot, button[data-time], [data-cy="dining-period-slots"] button, [data-cy="dining-period-slots"] [role="button"], [data-cy="dining-period-slots"] > div, button, div[role="button"]')
          );
          const availableSlots = slotButtons.filter((btn) => {
            if (btn.closest && btn.closest('#inline-auto-sniper-panel')) return false;
            const txt = (btn.innerText || '').trim();
            const isTimeFormat = /\b\d{1,2}:\d{2}\b/.test(txt);
            if (!isTimeFormat) return false;
            const isFull = (btn.classList && (btn.classList.contains('full') || btn.classList.contains('disabled'))) ||
              btn.disabled || (btn.getAttribute && btn.getAttribute('aria-disabled') === 'true') || txt.includes('滿') || txt.includes('full') || txt.includes('候位') || txt.includes('Waitlist');
            return !isFull && isElementClickable(btn);
          });

          if (availableSlots.length === 0) return null;

          for (const pref of priorityList) {
            const trimmed = pref.trim();
            if (!trimmed) continue;
            const match = availableSlots.find((btn) => (btn.innerText || '').includes(trimmed));
            if (match) {
              match.click();
              log(`🎯 成功鎖定時段: ${trimmed}！`);
              this.clickSlotContinueButton();
              return trimmed;
            }
          }
        } catch (e) {
          console.warn('[InlineSniper] claimSlot 異常', e);
        }
        return null;
      },

      clickSlotContinueButton() {
        if (!doc) return false;
        try {
          const nextBtn = findClickableButton(/完成預訂|下一步|繼續|確認時段|立即預訂|Next|Continue/i);
          if (nextBtn) {
            nextBtn.click();
            log(`👉 已自動點擊時段確認按鈕：【${nextBtn.innerText.trim()}】`);
            return true;
          }
        } catch (e) {
          console.warn('[InlineSniper] clickSlotContinueButton 異常', e);
        }
        return false;
      },

      isContactFormPage() {
        if (!doc) return false;
        // 若畫面上存在可見的日期或時段選擇器，表示還在選位階段，絕不能誤判為已進入聯絡表單
        const slotPickerEl = doc.querySelector('[data-cy="dining-period-slots"], #date-picker, [data-date]');
        if (slotPickerEl && isElementClickable(slotPickerEl)) {
          return false;
        }

        const phoneInput = doc.querySelector('input#phone, input[data-cy="phone"], input[type="tel"]');
        const nameInput = doc.querySelector('input#name, input#familyName, input[data-cy="name"], input[data-cy="familyName"]');
        return !!(
          doc.getElementById('contact-form') ||
          (phoneInput && isElementClickable(phoneInput)) ||
          (nameInput && isElementClickable(nameInput))
        );
      },

      hasCreditCardDeposit() {
        if (!doc) return false;
        return !!doc.querySelector('iframe[src*="card"], iframe[src*="tappay"], #cardholder-name');
      },

      findSubmitButton() {
        if (!doc) return null;
        const directSubmit = doc.querySelector('button[data-cy="submit"], button[type="submit"].eERBSs');
        if (directSubmit && isElementClickable(directSubmit)) return directSubmit;

        return findClickableButton(
          /確認訂位|完成預訂|確認預約|立即預訂|送出預訂|確認送出|確認|下一步|Confirm|Reserve|Complete/i
        );
      },

      fillGuestDetails(guest) {
        if (!doc || !guest) return;

        // 姓名拆解 (自動支援單一欄位 name 與雙欄位 姓 familyName / 名 givenName)
        const nameParts = splitPersonName(guest.name);

        // 1. 雙欄位容器 (#names, #nameFields, [data-cy="names"]) 內部 input 配對填入
        const nameContainer = doc.querySelector('#names, #nameFields, [data-cy="names"], [data-cy="nameFields"]');
        if (nameContainer && typeof nameContainer.querySelectorAll === 'function') {
          const containerInputs = Array.from(nameContainer.querySelectorAll('input'));
          if (containerInputs.length >= 2) {
            const input0 = containerInputs[0];
            const input1 = containerInputs[1];
            const is0Given = (input0.id === 'givenName' || (input0.getAttribute && input0.getAttribute('data-cy') === 'givenName') || (input0.placeholder && input0.placeholder.includes('名')));
            if (is0Given) {
              setReactValue(input0, nameParts.givenName);
              setReactValue(input1, nameParts.familyName);
            } else {
              setReactValue(input0, nameParts.familyName);
              setReactValue(input1, nameParts.givenName);
            }
          }
        }

        // 2. 雙欄位姓名：姓氏 (customerNameFields = 2 或 4)
        const familyNameInput = doc.querySelector('input#familyName, input[data-cy="familyName"], input[name="familyName"], input[autocomplete="family-name"], input[placeholder*="姓"]');
        if (familyNameInput && nameParts.familyName && familyNameInput.value !== nameParts.familyName) {
          setReactValue(familyNameInput, nameParts.familyName);
        }

        // 3. 雙欄位姓名：名字
        const givenNameInput = doc.querySelector('input#givenName, input[data-cy="givenName"], input[name="givenName"], input[autocomplete="given-name"], input[placeholder*="名"]');
        if (givenNameInput && nameParts.givenName && givenNameInput.value !== nameParts.givenName) {
          setReactValue(givenNameInput, nameParts.givenName);
        }

        // 4. 單一全名欄位 (customerNameFields = 1)
        const nameInput = doc.querySelector('input#name, input[data-cy="name"], input[name="name"], input[autocomplete="name"]');
        if (nameInput && guest.name && nameInput.value !== guest.name) {
          setReactValue(nameInput, guest.name);
        }

        // 性別稱謂
        if (guest.gender === 'male') {
          const maleRadio = doc.querySelector('#gender-male, button#gender-male, input#gender-male, [data-cy="gender-male"], [data-testid="gender-male"]');
          if (maleRadio && ((maleRadio.getAttribute && maleRadio.getAttribute('aria-checked') === 'false') || (maleRadio.type === 'radio' && !maleRadio.checked))) {
            maleRadio.click();
          }
        } else if (guest.gender === 'female') {
          const femaleRadio = doc.querySelector('#gender-female, button#gender-female, input#gender-female, [data-cy="gender-female"], [data-testid="gender-female"]');
          if (femaleRadio && ((femaleRadio.getAttribute && femaleRadio.getAttribute('aria-checked') === 'false') || (femaleRadio.type === 'radio' && !femaleRadio.checked))) {
            femaleRadio.click();
          }
        }
        // 電話
        const phoneInput = doc.querySelector('input#phone, input[data-cy="phone"], input[type="tel"], input[name="phone"]');
        if (phoneInput && guest.phone && phoneInput.value !== guest.phone) {
          setReactValue(phoneInput, guest.phone);
        }
        // Email
        const emailInput = doc.querySelector('input#email, input[data-cy="email"], input[type="email"], input[name="email"]');
        if (emailInput && guest.email && emailInput.value !== guest.email) {
          setReactValue(emailInput, guest.email);
        }
        // 備註
        const noteArea = doc.querySelector('textarea, input#note, input[name="note"]');
        if (noteArea && guest.note && noteArea.value !== guest.note) {
          setReactValue(noteArea, guest.note);
        }
        // 條款核取方塊與各項勾選（含隱私權、服務條款與行銷優惠同意）
        const allCheckboxes = Array.from(
          doc.querySelectorAll('input[type="checkbox"], button[role="checkbox"], [role="checkbox"]')
        );
        allCheckboxes.forEach((cb) => {
          if (cb.type === 'checkbox') {
            if (!cb.checked && !cb.disabled) cb.click();
          } else if (cb.getAttribute && (cb.getAttribute('aria-checked') === 'false' || cb.getAttribute('data-state') === 'unchecked')) {
            cb.click();
          }
        });
        log('📝 已自動填妥聯絡人資料與條款勾選');
      },

      submitReservation(guestDetails, policy = { autoSubmit: true }) {
        return new Promise((resolve) => {
          let waitAttempts = 0;

          const proceedToForm = () => {
            waitAttempts++;
            // 點擊時段確認按鈕推進流程
            this.clickSlotContinueButton();
            this.acknowledgeHouseRules();

            const isFormReady = this.isContactFormPage();
            if (isFormReady || waitAttempts >= 20) {
              fillAndSubmit();
            } else {
              setTimeout(proceedToForm, 100);
            }
          };

          const fillAndSubmit = () => {
            this.fillGuestDetails(guestDetails);

            if (this.hasCreditCardDeposit()) {
              log('💳 偵測到需要信用卡保證金！依資安規範暫停自動送出，請手動確認填寫卡號！');
              resolve({
                success: false,
                status: 'DEPOSIT_REQUIRED',
                message: 'Credit card deposit required',
              });
              return;
            }

            if (!policy.autoSubmit) {
              log('🔔 依預約政策暫停自動送出，請確認畫面資訊後手動點擊送出！');
              resolve({
                success: false,
                status: 'HELD_FOR_MANUAL_SUBMISSION',
                message: 'Held for manual submission',
              });
              return;
            }

            log('🚀 啟動全自動送出程序，正在等待確認預約按鈕...');
            let attempts = 0;
            const interval = setInterval(() => {
              attempts++;
              // 每次輪詢確保個資填寫與勾選皆完整生效
              this.fillGuestDetails(guestDetails);

              const submitBtn = this.findSubmitButton();
              if (submitBtn) {
                clearInterval(interval);
                log(`🚀 成功自動點擊【${submitBtn.innerText.trim()}】！完成預約送出！`);
                submitBtn.click();
                resolve({
                  success: true,
                  status: 'CONFIRMED',
                  message: 'Reservation submitted successfully',
                });
              } else if (attempts >= 25) {
                clearInterval(interval);
                log('🔔 已填妥個資，但未偵測到送出按鈕，請手動確認送出！');
                resolve({
                  success: false,
                  status: 'SUBMIT_TIMEOUT',
                  message: 'Submit button timed out',
                });
              }
            }, 120);
          };

          proceedToForm();
        });
      },

      _setReactValue: setReactValue,
    };
  }

  const InlineDomAdapter = createInlineDomAdapter();

  // ==========================================
  // 6. 搶位排程引擎模組 (SnipingEngine)
  // 依據 ADR-0003 透過 ReservationTarget 縫隙驅動開搶與撿漏，絕不直接碰觸 DOM
  // ==========================================
  // 6. 搶位排程引擎模組 (SnipingEngine)
  // 依據 ADR-0003 透過 ReservationTarget 縫隙驅動開搶與撿漏，絕不直接碰觸 DOM
  // ==========================================
  function parsePrioritySlots(rawSlots) {
    if (!rawSlots) return [];
    return String(rawSlots)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const SnipingState = {
    IDLE: 'IDLE',
    COUNTDOWN: 'COUNTDOWN',
    ACTIVE_SNIPING: 'ACTIVE_SNIPING',
    AWAITING_MANUAL_DEPOSIT: 'AWAITING_MANUAL_DEPOSIT',
    AWAITING_MANUAL_ACTION: 'AWAITING_MANUAL_ACTION',
    COMPLETED: 'COMPLETED',
    // 相容別名 (Compatibility Aliases)
    AWAITING_FORM: 'ACTIVE_SNIPING',
    HALTED_DEPOSIT: 'AWAITING_MANUAL_DEPOSIT',
  };

  function createSnipingEngine(deps = {}) {
    const adapter = deps.adapter || InlineDomAdapter;
    const configProvider = deps.getConfig || (() => config);
    const timeProvider = deps.getNow || getSyncedNow;
    const logger = deps.logger || addLog;
    const onStatusUpdate = deps.onStatusUpdate || updateStatusUI;
    const onNotify = deps.onNotify || ((title, body) => {
      playSuccessSound();
      showNotification(title, body);
    });
    const onRunStateChange = deps.onRunStateChange || (() => {});
    const cancellationDateRetryIntervalMs = Number.isFinite(Number(deps.cancellationDateRetryIntervalMs))
      ? Math.max(0, Number(deps.cancellationDateRetryIntervalMs))
      : 100;
    const cancellationDateRetryLimit = Number.isFinite(Number(deps.cancellationDateRetryLimit))
      ? Math.max(0, Math.floor(Number(deps.cancellationDateRetryLimit)))
      : 3;

    let currentStatus = SnipingState.IDLE;
    let currentMode = null;
    let timerId = null;
    let pollTimeoutId = null;
    let dropIntervalId = null;
    let cancellationDateRetryTimeoutId = null;

    function setStatus(newStatus, displayTxt, timeStr, running = true) {
      currentStatus = newStatus;
      if (onStatusUpdate) {
        onStatusUpdate(displayTxt, timeStr, running);
      }
    }

    function clearAllTimers() {
      if (timerId) clearInterval(timerId);
      if (pollTimeoutId) clearTimeout(pollTimeoutId);
      if (dropIntervalId) clearInterval(dropIntervalId);
      if (cancellationDateRetryTimeoutId) clearTimeout(cancellationDateRetryTimeoutId);
      timerId = null;
      pollTimeoutId = null;
      dropIntervalId = null;
      cancellationDateRetryTimeoutId = null;
    }

    function stop() {
      clearAllTimers();
      currentStatus = SnipingState.IDLE;
      state.isRunning = false;
      onRunStateChange({ active: false, mode: currentMode });
      setStatus(SnipingState.IDLE, '🔴 待命', '--:--:--', false);
      logger('⏹️ 搶位程序已停止');
    }

    function finishPersistedRun() {
      state.isRunning = false;
      onRunStateChange({ active: false, mode: currentMode });
    }

    function submitCurrentReservation() {
      const cfg = configProvider();
      if (currentMode === 'cancellation') {
        onRunStateChange({
          active: true,
          mode: currentMode,
          phase: CancellationPhase.SUBMITTING,
        });
      }
      setStatus(SnipingState.ACTIVE_SNIPING, '🟢 鎖定時段，提交中...', '--:--:--', true);
      adapter.submitReservation({
        name: cfg.userName,
        gender: cfg.userGender,
        phone: cfg.userPhone,
        email: cfg.userEmail,
        note: cfg.bookingNote,
        tablePreference: cfg.tablePreference,
      }, {
        autoSubmit: true,
      }).then((res) => {
        if (res.status === 'CONFIRMED') {
          clearAllTimers();
          finishPersistedRun();
          setStatus(SnipingState.COMPLETED, '🟢 預約完成', '00:00:00', false);
          onNotify('Inline 訂位完成', '已自動為您點擊送出完成預約！請檢查信箱或簡訊確認信。');
        } else if (res.status === 'DEPOSIT_REQUIRED') {
          clearAllTimers();
          finishPersistedRun();
          setStatus(SnipingState.AWAITING_MANUAL_DEPOSIT, '💳 需保證金', '--:--:--', false);
          onNotify('Inline 搶位提醒', '已成功鎖定時段！請立即於視窗確認並完成信用卡預授權。');
        } else if (res.status === 'SUBMIT_TIMEOUT' || res.status === 'HELD_FOR_MANUAL_SUBMISSION') {
          clearAllTimers();
          finishPersistedRun();
          setStatus(SnipingState.COMPLETED, '🔔 時段已鎖定', '--:--:--', false);
          onNotify('Inline 搶位成功', '時段已鎖定！請點擊頁面送出完成預約。');
        }
      }, (err) => {
        clearAllTimers();
        finishPersistedRun();
        setStatus(
          SnipingState.AWAITING_MANUAL_ACTION,
          '⚠️ 請手動完成預約',
          '--:--:--',
          false
        );
        logger(`❌ 送出預約時發生異常: ${err?.message || err}`);
        onNotify('Inline 自動送出失敗', '自動送出發生異常，請立即在目前頁面手動完成預約。');
      }).catch((err) => {
        logger(`❌ 處理預約結果時發生異常: ${err?.message || err}`);
      });
    }

    function executeCancellationCycle() {
      adapter.acknowledgeHouseRules();
      const cfg = configProvider();
      adapter.setPartySize(cfg.adults, cfg.kids);

      const dateSelected = adapter.selectDate(cfg.targetDate);
      if (!dateSelected) {
        retryCancellationDateSelection(cfg);
        return;
      }

      finishCancellationCycle(cfg);
    }

    function finishCancellationCycle(cfg) {
      adapter.selectTableType(parsePrioritySlots(cfg.tablePreference));
      const priorityList = parsePrioritySlots(cfg.prioritySlots);
      const picked = adapter.claimSlot(priorityList);

      if (picked) {
        submitCurrentReservation();
      } else {
        scheduleNextPoll();
      }
    }

    function retryCancellationDateSelection(cfg, retries = 0) {
      if (retries >= cancellationDateRetryLimit) {
        logger(`⏳ 目標日期 【${cfg.targetDate}】 尚未完成選取或尚未開放，將於下次輪詢時重試...`);
        scheduleNextPoll();
        return;
      }

      cancellationDateRetryTimeoutId = setTimeout(() => {
        cancellationDateRetryTimeoutId = null;
        if (!state.isRunning) return;

        if (adapter.selectDate(cfg.targetDate)) {
          finishCancellationCycle(cfg);
          return;
        }

        retryCancellationDateSelection(cfg, retries + 1);
      }, cancellationDateRetryIntervalMs);
    }

    function scheduleNextPoll() {
      if (currentStatus === SnipingState.IDLE && !state.isRunning) return;
      const cfg = configProvider();
      const interval = Math.floor(
        Math.random() * (cfg.pollIntervalMax - cfg.pollIntervalMin + 1) + cfg.pollIntervalMin
      );
      logger(`⏳ 目前無空位，將於 ${(interval / 1000).toFixed(1)} 秒後重新整理頁面查詢...`);
      pollTimeoutId = setTimeout(() => {
        const reloaded = adapter.reloadPage && adapter.reloadPage();
        if (!reloaded) {
          logger('❌ 無法重新整理頁面，釋出撿漏已停止');
          stop();
        }
      }, interval);
    }

    function scheduleDropSnipe() {
      const cfg = configProvider();
      const now = timeProvider();
      const [targetHour, targetMinute, targetSecond] = (cfg.dropTime || '00:00:00').split(':').map(Number);
      const dropDate = new Date(now);
      dropDate.setHours(targetHour, targetMinute, targetSecond || 0, 0);

      if (dropDate.getTime() <= now) {
        dropDate.setDate(dropDate.getDate() + 1);
      }

      const diffMs = dropDate.getTime() - now;
      logger(`⏰ 目標開搶時間: ${dropDate.toLocaleTimeString()} (距離 ${Math.round(diffMs / 1000)} 秒)`);
      setStatus(SnipingState.COUNTDOWN, '🟡 等待開搶中', '--:--:--', true);

      if (timerId) clearInterval(timerId);
      timerId = setInterval(() => {
        const remainingMs = dropDate.getTime() - timeProvider();
        const leadTime = Number(cfg.leadTimeMs) || 0;
        if (remainingMs <= leadTime) {
          clearInterval(timerId);
          timerId = null;
          setStatus(SnipingState.ACTIVE_SNIPING, '🟢 開搶觸發中！', '00:00:00', true);
          triggerDropAction();
        } else {
          const sec = Math.floor(remainingMs / 1000) % 60;
          const min = Math.floor(remainingMs / (1000 * 60)) % 60;
          const hr = Math.floor(remainingMs / (1000 * 60 * 60));
          const formatted = `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${Math.floor((remainingMs % 1000) / 100)}`;
          setStatus(SnipingState.COUNTDOWN, '🟡 等待開搶中', formatted, true);
        }
      }, 80);
    }

    function triggerDropAction() {
      logger('⚡ 開搶時間到達！執行毫秒級搶位程序！');
      const cfg = configProvider();
      const priorityList = parsePrioritySlots(cfg.prioritySlots);

      let attempts = 0;
      function attempt() {
        attempts++;
        adapter.acknowledgeHouseRules();
        adapter.setPartySize(cfg.adults, cfg.kids);

        const dateSelected = adapter.selectDate(cfg.targetDate);
        if (!dateSelected) {
          if (attempts === 1) {
            logger(`⏳ 目標日期 【${cfg.targetDate}】 尚未完成選取或尚未開放，等待頁面更新...`);
          }
          if (attempts >= 30) {
            if (dropIntervalId) {
              clearInterval(dropIntervalId);
              dropIntervalId = null;
            }
            logger(`❌ 搶位結束：無法確認目標日期 【${cfg.targetDate}】 已完成選取`);
            stop();
            return false;
          }
          return false;
        }

        adapter.selectTableType(parsePrioritySlots(cfg.tablePreference));
        const picked = adapter.claimSlot(priorityList);

        if (picked) {
          if (dropIntervalId) {
            clearInterval(dropIntervalId);
            dropIntervalId = null;
          }
          submitCurrentReservation();
          return true;
        }

        if (attempts >= 30) {
          if (dropIntervalId) {
            clearInterval(dropIntervalId);
            dropIntervalId = null;
          }
          logger('❌ 搶位結束：指定時段未能成功取得');
          stop();
          return false;
        }
        return false;
      }

      // 0ms 首拍立即執行，消除 120ms 初始延遲
      const instantPicked = attempt();
      if (!instantPicked && attempts < 30) {
        dropIntervalId = setInterval(attempt, 120);
      }
    }

    function start(resumeState = null) {
      clearAllTimers();
      const cfg = configProvider();
      currentMode = cfg.mode;
      const resumedPhase = currentMode === 'cancellation' && (
        resumeState?.phase === CancellationPhase.MONITORING ||
        resumeState?.phase === CancellationPhase.SUBMITTING
      )
        ? resumeState.phase
        : null;

      const runStateChanged = onRunStateChange({
        active: true,
        mode: currentMode,
        ...(resumedPhase ? { phase: resumedPhase } : {}),
      });
      if (currentMode === 'cancellation' && runStateChanged === false) {
        state.isRunning = false;
        setStatus(SnipingState.IDLE, '🔴 無法啟動', '--:--:--', false);
        logger('❌ 無法啟動釋出撿漏：瀏覽器無法儲存重新整理後的續跑狀態');
        return false;
      }

      state.isRunning = true;
      setStatus(SnipingState.ACTIVE_SNIPING, '🟢 運行中', '--:--:--', true);
      logger(`🚀 搶位程序啟動 [模式: ${cfg.mode === 'drop' ? '準時放位' : '釋出撿漏'}]`);

      if (resumedPhase === CancellationPhase.SUBMITTING) {
        logger('📋 已恢復鎖定時段後的自動填表與送出程序');
        submitCurrentReservation();
        return true;
      }

      if (resumedPhase === CancellationPhase.MONITORING) {
        executeCancellationCycle();
        return true;
      }

      // 若目前畫面已就緒聯絡資訊表單，直接進入送出程序
      if (adapter.isContactFormPage && adapter.isContactFormPage()) {
        logger('📋 偵測到已在聯絡資訊頁面，立即執行自動填表與送出！');
        submitCurrentReservation();
        return true;
      }

      if (cfg.mode === 'drop') {
        scheduleDropSnipe();
      } else {
        executeCancellationCycle();
      }
      return true;
    }

    return {
      start,
      stop,
      getStatus: () => currentStatus,
      triggerDropAction,
      executeCancellationCycle,
      proceedToContactForm: submitCurrentReservation,
      scheduleNextPoll,
      scheduleDropSnipe,
      submitCurrentReservation,
    };
  }

  const SnipingEngine = createSnipingEngine({
    onRunStateChange(event) {
      if (event.active && event.mode === 'cancellation') {
        return runtimeStateStore.activate(getCurrentBookingTarget(), event.phase);
      } else {
        return runtimeStateStore.deactivate();
      }
    },
  });

  // 頂層調度進入點 (Top-Level Controller)
  function startSniper() {
    SnipingEngine.start();
  }

  function stopSniper() {
    SnipingEngine.stop();
  }

  // ==========================================
  // 7. 初始化與面板掛載
  // ==========================================
  let resumeAttempted = false;

  function attemptCancellationResume() {
    if (resumeAttempted || typeof document === 'undefined' || !document.body) return false;
    resumeAttempted = true;
    return resumePersistedCancellation({
      store: runtimeStateStore,
      bookingTarget: getCurrentBookingTarget(),
      mode: config.mode,
      start: (resumeState) => SnipingEngine.start(resumeState),
      logger: addLog,
    });
  }

  function ensureFloatingPanel() {
    if (typeof window === 'undefined' || !window.location || !window.location.hostname || !window.location.hostname.includes('inline.app')) return;
    if (document.getElementById('inline-auto-sniper-panel')) return;
    if (!document.body) {
      setTimeout(ensureFloatingPanel, 100);
      return;
    }
    createFloatingPanel();
  }

  function init() {
    if (typeof window === 'undefined' || !window.location || !window.location.hostname || !window.location.hostname.includes('inline.app')) return;

    ensureFloatingPanel();
    InlineDomAdapter.acknowledgeHouseRules();
    checkCaptchaAlert();
    attemptCancellationResume();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        ensureFloatingPanel();
        InlineDomAdapter.acknowledgeHouseRules();
        checkCaptchaAlert();
        attemptCancellationResume();
      });
    }
    window.addEventListener('load', () => {
      ensureFloatingPanel();
      InlineDomAdapter.acknowledgeHouseRules();
      checkCaptchaAlert();
      attemptCancellationResume();
    });

    // 每 600ms 檢查一次：確保面板存在、自動勾選同意彈出的用餐須知，並在出現驗證碼時即刻發出警報聲
    setInterval(() => {
      ensureFloatingPanel();
      InlineDomAdapter.acknowledgeHouseRules();
      checkCaptchaAlert();
    }, 600);
  }

  init();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createInlineDomAdapter,
      InlineDomAdapter,
      clearSiteCacheWithSnipingStopped,
      createRuntimeStateStore,
      resumePersistedCancellation,
      createSnipingEngine,
      SnipingEngine,
      SnipingState,
    };
  }
})();
