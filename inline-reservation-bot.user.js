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
  };

  // 讀取/儲存設定
  function loadConfig() {
    try {
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
  // 5. 核心自動化邏輯 (Core Automation)
  // ==========================================

  // 自動同意用餐須知 (House Rules Modal)
  function handleHouseRules() {
    const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
    const confirmBtn = buttons.find((btn) => {
      const txt = (btn.innerText || '').trim();
      return txt === '我同意' || txt === '我知道了' || txt === '同意並繼續' || txt === 'OK' || txt === '確定' || txt === '繼續訂位';
    });
    if (confirmBtn && confirmBtn.offsetParent !== null) {
      confirmBtn.click();
      addLog('📋 自動確認用餐須知 (House Rules)');
      return true;
    }
    return false;
  }

  // 設定大人與小孩人數
  function setPartySize() {
    // 檢查 adult picker
    const adultPicker = document.getElementById('adult-picker') || document.querySelector('select[name="adult"]');
    if (adultPicker && adultPicker.value !== config.adults) {
      adultPicker.value = config.adults;
      adultPicker.dispatchEvent(new Event('change', { bubbles: true }));
      addLog(`👥 設定大人人數: ${config.adults}`);
    }

    const kidPicker = document.getElementById('kid-picker') || document.querySelector('select[name="kid"]');
    if (kidPicker && kidPicker.value !== config.kids) {
      kidPicker.value = config.kids;
      kidPicker.dispatchEvent(new Event('change', { bubbles: true }));
      addLog(`👶 設定小孩人數: ${config.kids}`);
    }
  }

  // 嘗試選取目標日期
  function selectTargetDate() {
    if (!config.targetDate) return true;

    // 日期元件可能以 data-date="YYYY-MM-DD" 或文字顯示
    const targetDateFormatted = config.targetDate.replace(/-/g, ''); // 20260827
    const dayElements = Array.from(document.querySelectorAll('[data-date], button, div[role="button"]'));

    const matchDateEl = dayElements.find((el) => {
      const dataDate = el.getAttribute('data-date') || '';
      return dataDate === config.targetDate || dataDate.replace(/-/g, '') === targetDateFormatted;
    });

    if (matchDateEl && !matchDateEl.classList.contains('disabled') && !matchDateEl.hasAttribute('disabled')) {
      matchDateEl.click();
      addLog(`📅 點擊目標日期: ${config.targetDate}`);
      return true;
    }
    return false;
  }

  // 掃描並點選符合優先名單的時段 (Priority Slot Sniping)
  function attemptPickSlot() {
    const priorityList = config.prioritySlots
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // 取得所有時段按鈕
    const slotButtons = Array.from(document.querySelectorAll('button.time-slot, button[data-time], button'));
    const availableSlots = slotButtons.filter((btn) => {
      const txt = (btn.innerText || '').trim();
      const isTimeFormat = /\b\d{1,2}:\d{2}\b/.test(txt);
      if (!isTimeFormat) return false;

      const isFull = btn.classList.contains('full') || btn.classList.contains('disabled') || btn.disabled || txt.includes('滿') || txt.includes('full');
      return !isFull && btn.offsetParent !== null;
    });

    if (availableSlots.length === 0) {
      return null;
    }

    // 依優先名單進行比對
    for (const pref of priorityList) {
      const match = availableSlots.find((btn) => (btn.innerText || '').includes(pref));
      if (match) {
        match.click();
        addLog(`🎯 成功鎖定第一志願時段: ${pref}！`);
        return pref;
      }
    }

    // 若優先時段皆無，但有其他時段可選（若使用者未強制要求嚴格匹配）
    return null;
  }

  // 表單自動填寫
  function fillReservationForm() {
    // 姓名
    const nameInput = document.querySelector('input#name, input[name="name"]');
    if (nameInput && config.userName && nameInput.value !== config.userName) {
      nameInput.value = config.userName;
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 性別稱謂
    if (config.userGender === 'male') {
      const maleRadio = document.querySelector('input#gender-male, input[value="male"], input[value="MR"]');
      if (maleRadio && !maleRadio.checked) maleRadio.click();
    } else if (config.userGender === 'female') {
      const femaleRadio = document.querySelector('input#gender-female, input[value="female"], input[value="MS"]');
      if (femaleRadio && !femaleRadio.checked) femaleRadio.click();
    }

    // 電話
    const phoneInput = document.querySelector('input#phone, input[type="tel"], input[name="phone"]');
    if (phoneInput && config.userPhone && phoneInput.value !== config.userPhone) {
      phoneInput.value = config.userPhone;
      phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
      phoneInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Email
    const emailInput = document.querySelector('input#email, input[type="email"], input[name="email"]');
    if (emailInput && config.userEmail && emailInput.value !== config.userEmail) {
      emailInput.value = config.userEmail;
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 備註
    const noteArea = document.querySelector('textarea, input#note, input[name="note"]');
    if (noteArea && config.bookingNote && noteArea.value !== config.bookingNote) {
      noteArea.value = config.bookingNote;
      noteArea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 勾選所有條款核取方塊
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    checkboxes.forEach((cb) => {
      if (!cb.checked && !cb.disabled) {
        cb.click();
      }
    });

    addLog('📝 已自動填妥聯絡人資料與條款勾選');

    // 檢查是否有信用卡保證金 (Deposit Policy)
    const hasCreditCardIframe = !!document.querySelector('iframe[src*="card"], iframe[src*="tappay"], #cardholder-name');
    if (hasCreditCardIframe) {
      addLog('💳 偵測到需要信用卡保證金！依資安規範暫停自動送出，請手動確認填寫卡號！');
      playSuccessSound();
      showNotification('Inline 搶位提醒', '已成功鎖定時段！請立即於視窗確認並完成信用卡預授權。');
      stopSniper();
      return;
    }

    // 若無需訂金且開啟全自動送出
    if (config.autoSubmitFree) {
      const submitBtn = document.querySelector('button[type="submit"], button#submit-booking, button.submit-button');
      if (submitBtn && !submitBtn.disabled) {
        addLog('🚀 觸發自動確認送出！');
        submitBtn.click();
        playSuccessSound();
        showNotification('Inline 訂位完成', '已自動送出訂位表單！請檢查信箱或簡訊確認信。');
        stopSniper();
      }
    } else {
      addLog('🔔 已鎖定時段並填好個資，請點擊送出按鈕完成預訂');
      playSuccessSound();
      showNotification('Inline 搶位成功', '時段已鎖定！請點擊頁面送出完成預約。');
      stopSniper();
    }
  }

  // 單次執行循環
  function executeSnipeCycle() {
    handleHouseRules();
    setPartySize();

    // 檢查是否已在聯絡人表單頁面
    const contactForm = document.getElementById('contact-form') || document.querySelector('form');
    const isContactFormPage = contactForm && document.querySelector('input#name, input#phone');
    if (isContactFormPage) {
      fillReservationForm();
      return;
    }

    // 選取日期
    selectTargetDate();

    // 嘗試選取時段
    const picked = attemptPickSlot();
    if (picked) {
      // 成功選到時段，等待短暫過渡至表單
      setTimeout(() => {
        fillReservationForm();
      }, 350);
    } else {
      // 尚未有可選時段
      if (config.mode === 'cancellation') {
        scheduleNextPoll();
      }
    }
  }

  // 輪詢撿漏調度 (Cancellation Sniping)
  function scheduleNextPoll() {
    if (!state.isRunning) return;
    const interval = Math.floor(
      Math.random() * (config.pollIntervalMax - config.pollIntervalMin + 1) + config.pollIntervalMin
    );
    addLog(`⏳ 目前無空位，將於 ${(interval / 1000).toFixed(1)} 秒後自動刷新查詢...`);
    state.pollTimeoutId = setTimeout(() => {
      // 軟刷新：重新點擊目標日期或重觸發查詢
      const refreshed = selectTargetDate();
      if (!refreshed) {
        // 若無法軟點擊，微距重新整理
        location.reload();
      } else {
        setTimeout(executeSnipeCycle, 400);
      }
    }, interval);
  }

  // 準時放位倒數調度 (Opening Drop Sniping)
  function scheduleDropSnipe() {
    if (!state.isRunning) return;

    const now = getSyncedNow();
    const [targetHour, targetMinute, targetSecond] = config.dropTime.split(':').map(Number);
    const dropDate = new Date(now);
    dropDate.setHours(targetHour, targetMinute, targetSecond || 0, 0);

    // 若今天時間已過目標時間，設為次日
    if (dropDate.getTime() <= now) {
      dropDate.setDate(dropDate.getDate() + 1);
    }

    const diffMs = dropDate.getTime() - now;
    const targetTriggerMs = diffMs - config.leadTimeMs;

    addLog(`⏰ 目標開搶時間: ${dropDate.toLocaleTimeString()} (距離 ${Math.round(diffMs / 1000)} 秒)`);

    // 啟動 UI 倒數計時器
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = setInterval(() => {
      const remainingMs = dropDate.getTime() - getSyncedNow();
      if (remainingMs <= 0) {
        clearInterval(state.timerId);
        updateStatusUI('🟢 開搶觸發中！', '00:00:00', true);
        triggerDropAction();
      } else {
        const sec = Math.floor(remainingMs / 1000) % 60;
        const min = Math.floor(remainingMs / (1000 * 60)) % 60;
        const hr = Math.floor(remainingMs / (1000 * 60 * 60));
        const formatted = `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${Math.floor((remainingMs % 1000) / 100)}`;
        updateStatusUI('🟡 等待開搶中', formatted, true);
      }
    }, 80);
  }

  function triggerDropAction() {
    addLog('⚡ 開搶時間到達！執行毫秒級搶位程序！');
    // 檢查目標日期是否存在，若不存在則在 T-200ms 刷新
    const dateSelected = selectTargetDate();
    if (!dateSelected) {
      addLog('🔄 目標日期尚未出現在畫面上，執行極速刷新...');
      location.reload();
      return;
    }

    // 進行高頻重試時段抓取
    let attempts = 0;
    const dropInterval = setInterval(() => {
      attempts++;
      handleHouseRules();
      setPartySize();
      selectTargetDate();
      const picked = attemptPickSlot();
      if (picked || attempts >= 25) {
        clearInterval(dropInterval);
        if (picked) {
          setTimeout(fillReservationForm, 300);
        } else {
          addLog('❌ 搶位結束：指定時段未能成功取得');
          stopSniper();
        }
      }
    }, 150);
  }

  function startSniper() {
    state.isRunning = true;
    updateStatusUI('🟢 運行中', '--:--:--', true);
    addLog(`🚀 搶位程序啟動 [模式: ${config.mode === 'drop' ? '準時放位' : '撿漏輪詢'}]`);

    if (config.mode === 'drop') {
      scheduleDropSnipe();
    } else {
      executeSnipeCycle();
    }
  }

  function stopSniper() {
    state.isRunning = false;
    if (state.timerId) clearInterval(state.timerId);
    if (state.pollTimeoutId) clearTimeout(state.pollTimeoutId);
    updateStatusUI('🔴 待命', '--:--:--', false);
    addLog('⏹️ 搶位程序已停止');
  }

  // ==========================================
  // 6. 初始化進入點
  // ==========================================
  function ensureFloatingPanel() {
    if (!window.location.hostname.includes('inline.app')) return;
    if (document.getElementById('inline-auto-sniper-panel')) return;
    if (!document.body) {
      setTimeout(ensureFloatingPanel, 100);
      return;
    }
    createFloatingPanel();
  }

  function init() {
    if (!window.location.hostname.includes('inline.app')) return;

    ensureFloatingPanel();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureFloatingPanel);
    }
    window.addEventListener('load', ensureFloatingPanel);

    // 每秒檢查一次，防止 SPA 頁面切換、水合 (Hydration) 或動態渲染將懸浮面板卸載
    setInterval(ensureFloatingPanel, 1000);
  }

  init();
})();
