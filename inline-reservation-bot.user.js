// ==UserScript==
// @name         Inline 餐廳自動搶位助手 (Inline Booking Sniper)
// @namespace    https://github.com/inline-agent
// @version      1.0.0
// @description  支援準時放位開搶 (Opening Drop) 與釋出撿漏 (Cancellation Sniping)，自動校正伺服器時間、秒選時段、填寫表單並提供音效與桌面通知。
// @author       Antigravity
// @match        https://inline.app/*
// @match        https://*.inline.app/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ==========================================
  // 1. 常數與預設設定
  // ==========================================
  const STORAGE_KEY = 'INLINE_SNIPER_CONFIG_V1';
  const DEFAULT_CONFIG = {
    enabled: false,
    mode: 'drop', // 'drop' (準時放位開搶) | 'cancellation' (撿漏輪詢)
    targetDate: '', // YYYY-MM-DD
    adults: '2',
    kids: '0',
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
    autoSubmitFree: true, // 免訂金是否全自動送出
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

  // ==========================================
  // 2. 音效與系統通知模組 (Web Audio & Notification)
  // ==========================================
  function playSuccessSound() {
    if (!config.soundAlert) return;
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
    if (!config.soundAlert) return;
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
    if (document.getElementById('inline-auto-sniper-panel')) return;

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
              <input type="checkbox" id="ias-auto-submit" ${config.autoSubmitFree ? 'checked' : ''}> 免訂金自動送出
            </label>
            <label style="display: inline-flex; align-items: center; gap: 4px; font-weight: normal; cursor: pointer;">
              <input type="checkbox" id="ias-sound" ${config.soundAlert ? 'checked' : ''}> 鈴聲通知
            </label>
          </div>

          <div class="ias-btn-row">
            <button class="ias-btn ias-btn-save" id="ias-btn-save">💾 儲存設定</button>
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
    bindPanelEvents();
    syncServerTime();
  }

  function bindPanelEvents() {
    const toggleBtn = document.getElementById('ias-toggle-btn');
    const mainCard = document.getElementById('ias-main-card');
    const closeBtn = document.getElementById('ias-close-btn');
    const saveBtn = document.getElementById('ias-btn-save');
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
    config.prioritySlots = document.getElementById('ias-priority-slots').value;
    config.userName = document.getElementById('ias-user-name').value.trim();
    config.userGender = document.getElementById('ias-user-gender').value;
    config.userPhone = document.getElementById('ias-user-phone').value.trim();
    config.userEmail = document.getElementById('ias-user-email').value.trim();
    config.bookingNote = document.getElementById('ias-booking-note').value.trim();
    config.autoSubmitFree = document.getElementById('ias-auto-submit').checked;
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

    function isElementClickable(el) {
      if (!el || el.disabled || (el.classList && el.classList.contains('disabled'))) return false;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
      return el.offsetParent !== null;
    }

    function setReactValue(element, val) {
      if (!element || val === undefined || val === null || val === '') return;
      try {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) {
          descriptor.set.call(element, val);
        } else {
          element.value = val;
        }
        if (typeof Event === 'function') {
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {
        element.value = val;
      }
    }

    return {
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

          const candidateButtons = Array.from(
            doc.querySelectorAll('button, a, div[role="button"], input[type="button"], span[role="button"]')
          );
          const confirmBtn = candidateButtons.find((btn) => {
            if (!isElementClickable(btn)) return false;
            const txt = (btn.innerText || btn.value || '').trim();
            return (
              /我已閱讀並同意|我同意|我知道了|同意並繼續|繼續訂位|同意|我知道|確定|繼續|OK|Agree/i.test(txt) &&
              !/取消|不同意|Close/i.test(txt)
            );
          });

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
          const dayElements = Array.from(doc.querySelectorAll('[data-date], button, div[role="button"]'));
          const matchDateEl = dayElements.find((el) => {
            const dataDate = (el.getAttribute && el.getAttribute('data-date')) || '';
            return dataDate === targetDate || dataDate.replace(/-/g, '') === targetDateFormatted;
          });

          if (matchDateEl && isElementClickable(matchDateEl)) {
            matchDateEl.click();
            log(`📅 點擊目標日期: ${targetDate}`);
            return true;
          }
        } catch (e) {
          console.warn('[InlineSniper] selectDate 異常', e);
        }
        return false;
      },

      claimSlot(priorityList) {
        if (!doc || !priorityList) return null;
        try {
          const slotButtons = Array.from(doc.querySelectorAll('button.time-slot, button[data-time], button'));
          const availableSlots = slotButtons.filter((btn) => {
            const txt = (btn.innerText || '').trim();
            const isTimeFormat = /\b\d{1,2}:\d{2}\b/.test(txt);
            if (!isTimeFormat) return false;
            const isFull = (btn.classList && (btn.classList.contains('full') || btn.classList.contains('disabled'))) ||
              btn.disabled || txt.includes('滿') || txt.includes('full');
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
          const candidateButtons = Array.from(
            doc.querySelectorAll('button, a, div[role="button"], input[type="button"]')
          );
          const nextBtn = candidateButtons.find((btn) => {
            if (!isElementClickable(btn)) return false;
            const txt = (btn.innerText || btn.value || '').trim();
            return /完成預訂|下一步|繼續|確認時段|立即預訂|Next|Continue/i.test(txt);
          });
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
        return !!(doc.getElementById('contact-form') || doc.querySelector('input#name, input#phone'));
      },

      hasCreditCardDeposit() {
        if (!doc) return false;
        return !!doc.querySelector('iframe[src*="card"], iframe[src*="tappay"], #cardholder-name');
      },

      findSubmitButton() {
        if (!doc) return null;
        const directSubmit = doc.querySelector('button[data-cy="submit"], button[type="submit"].eERBSs');
        if (directSubmit && isElementClickable(directSubmit)) return directSubmit;

        const candidateButtons = Array.from(
          doc.querySelectorAll('button, input[type="submit"], div[role="button"], a[role="button"]')
        );
        return candidateButtons.find((btn) => {
          if (!isElementClickable(btn)) return false;
          const txt = (btn.innerText || btn.value || '').trim();
          return /確認訂位|完成預訂|確認預約|立即預訂|送出預訂|確認送出|確認|下一步|Confirm|Reserve|Complete/i.test(txt);
        });
      },

      fillGuestDetails(guest) {
        if (!doc || !guest) return;
        // 姓名
        const nameInput = doc.querySelector('input#name, input[data-cy="name"], input[name="name"]');
        if (nameInput && guest.name && nameInput.value !== guest.name) {
          setReactValue(nameInput, guest.name);
        }
        // 性別稱謂
        if (guest.gender === 'male') {
          const maleRadio = doc.querySelector('#gender-male, button#gender-male, input#gender-male');
          if (maleRadio && ((maleRadio.getAttribute && maleRadio.getAttribute('aria-checked') === 'false') || (maleRadio.type === 'radio' && !maleRadio.checked))) {
            maleRadio.click();
          }
        } else if (guest.gender === 'female') {
          const femaleRadio = doc.querySelector('#gender-female, button#gender-female, input#gender-female');
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
        // 條款核取方塊
        const allCheckboxes = Array.from(
          doc.querySelectorAll('input[type="checkbox"], button[role="checkbox"], [role="checkbox"]')
        );
        allCheckboxes.forEach((cb) => {
          if (cb.id === 'marketing-optin') return;
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
  const SnipingState = {
    IDLE: 'IDLE',
    COUNTDOWN: 'COUNTDOWN',
    ACTIVE_SNIPING: 'ACTIVE_SNIPING',
    AWAITING_FORM: 'AWAITING_FORM',
    COMPLETED: 'COMPLETED',
    HALTED_DEPOSIT: 'HALTED_DEPOSIT',
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

    let currentStatus = SnipingState.IDLE;
    let timerId = null;
    let pollTimeoutId = null;
    let dropIntervalId = null;
    let formWaitIntervalId = null;

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
      if (formWaitIntervalId) clearInterval(formWaitIntervalId);
      timerId = null;
      pollTimeoutId = null;
      dropIntervalId = null;
      formWaitIntervalId = null;
    }

    function stop() {
      clearAllTimers();
      currentStatus = SnipingState.IDLE;
      state.isRunning = false;
      setStatus(SnipingState.IDLE, '🔴 待命', '--:--:--', false);
      logger('⏹️ 搶位程序已停止');
    }

    function submitCurrentReservation() {
      const cfg = configProvider();
      adapter.submitReservation({
        name: cfg.userName,
        gender: cfg.userGender,
        phone: cfg.userPhone,
        email: cfg.userEmail,
        note: cfg.bookingNote,
      }, {
        autoSubmit: cfg.autoSubmitFree,
      }).then((res) => {
        if (res.status === 'CONFIRMED') {
          setStatus(SnipingState.COMPLETED, '🟢 預約完成', '00:00:00', false);
          onNotify('Inline 訂位完成', '已自動為您點擊送出完成預約！請檢查信箱或簡訊確認信。');
          stop();
        } else if (res.status === 'DEPOSIT_REQUIRED') {
          setStatus(SnipingState.HALTED_DEPOSIT, '💳 需保證金', '--:--:--', false);
          onNotify('Inline 搶位提醒', '已成功鎖定時段！請立即於視窗確認並完成信用卡預授權。');
          stop();
        } else if (res.status === 'SUBMIT_TIMEOUT' || res.status === 'HELD_FOR_MANUAL_SUBMISSION') {
          setStatus(SnipingState.COMPLETED, '🔔 時段已鎖定', '--:--:--', false);
          onNotify('Inline 搶位成功', '時段已鎖定！請點擊頁面送出完成預約。');
          stop();
        }
      }).catch((err) => {
        logger(`❌ 送出預約時發生異常: ${err?.message || err}`);
      });
    }

    function proceedToContactForm() {
      setStatus(SnipingState.AWAITING_FORM, '🟡 前往表單中', '--:--:--', true);
      logger('⏳ 時段已鎖定！正在推進流程進入聯絡人表單...');

      adapter.clickSlotContinueButton();

      let formAttempts = 0;
      formWaitIntervalId = setInterval(() => {
        formAttempts++;
        adapter.clickSlotContinueButton();
        adapter.acknowledgeHouseRules();

        if (adapter.isContactFormPage()) {
          clearInterval(formWaitIntervalId);
          formWaitIntervalId = null;
          logger('📋 已順利進入聯絡資訊頁面，開始填表與預約流程！');
          submitCurrentReservation();
          return;
        }

        if (formAttempts >= 180) {
          clearInterval(formWaitIntervalId);
          formWaitIntervalId = null;
          logger('⚠️ 等待聯絡資訊表單超時，請檢查畫面是否需手動確認');
        }
      }, 100);
    }

    function executeCancellationCycle() {
      adapter.acknowledgeHouseRules();
      const cfg = configProvider();
      adapter.setPartySize(cfg.adults, cfg.kids);

      if (adapter.isContactFormPage()) {
        submitCurrentReservation();
        return;
      }

      adapter.selectDate(cfg.targetDate);
      const priorityList = (cfg.prioritySlots || '').split(',').map((s) => s.trim()).filter(Boolean);
      const picked = adapter.claimSlot(priorityList);

      if (picked) {
        proceedToContactForm();
      } else {
        scheduleNextPoll();
      }
    }

    function scheduleNextPoll() {
      if (currentStatus === SnipingState.IDLE && !state.isRunning) return;
      const cfg = configProvider();
      const interval = Math.floor(
        Math.random() * (cfg.pollIntervalMax - cfg.pollIntervalMin + 1) + cfg.pollIntervalMin
      );
      logger(`⏳ 目前無空位，將於 ${(interval / 1000).toFixed(1)} 秒後自動軟刷新查詢...`);
      pollTimeoutId = setTimeout(() => {
        // 軟重觸發 (ADR-0002)：不執行 location.reload()
        const refreshed = adapter.selectDate(cfg.targetDate);
        if (!refreshed) {
          adapter.setPartySize(cfg.adults, cfg.kids);
        }
        setTimeout(executeCancellationCycle, 400);
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
        if (remainingMs <= 0) {
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
      const priorityList = (cfg.prioritySlots || '').split(',').map((s) => s.trim()).filter(Boolean);

      let attempts = 0;
      dropIntervalId = setInterval(() => {
        attempts++;
        adapter.acknowledgeHouseRules();
        adapter.setPartySize(cfg.adults, cfg.kids);
        adapter.selectDate(cfg.targetDate);
        const picked = adapter.claimSlot(priorityList);

        if (picked || attempts >= 30) {
          clearInterval(dropIntervalId);
          dropIntervalId = null;
          if (picked) {
            proceedToContactForm();
          } else {
            logger('❌ 搶位結束：指定時段未能成功取得');
            stop();
          }
        }
      }, 120);
    }

    function start() {
      clearAllTimers();
      state.isRunning = true;
      const cfg = configProvider();
      setStatus(SnipingState.ACTIVE_SNIPING, '🟢 運行中', '--:--:--', true);
      logger(`🚀 搶位程序啟動 [模式: ${cfg.mode === 'drop' ? '準時放位' : '撿漏輪詢'}]`);

      if (adapter.isContactFormPage()) {
        logger('📋 偵測到已在聯絡資訊頁面，立即執行自動填表與送出！');
        submitCurrentReservation();
        return;
      }

      if (cfg.mode === 'drop') {
        scheduleDropSnipe();
      } else {
        executeCancellationCycle();
      }
    }

    return {
      start,
      stop,
      getStatus: () => currentStatus,
      triggerDropAction,
      executeCancellationCycle,
      proceedToContactForm,
      scheduleNextPoll,
      scheduleDropSnipe,
      submitCurrentReservation,
    };
  }

  const SnipingEngine = createSnipingEngine();

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

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        ensureFloatingPanel();
        InlineDomAdapter.acknowledgeHouseRules();
        checkCaptchaAlert();
      });
    }
    window.addEventListener('load', () => {
      ensureFloatingPanel();
      InlineDomAdapter.acknowledgeHouseRules();
      checkCaptchaAlert();
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
      createSnipingEngine,
      SnipingEngine,
      SnipingState,
    };
  }
})();
