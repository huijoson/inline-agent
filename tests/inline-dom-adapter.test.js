const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Mock DOM helper to test adapter in headless node environment
function createMockElement(tagName = 'div', attrs = {}) {
  const listeners = {};
  const classes = new Set((attrs.className || '').split(' ').filter(Boolean));
  const attributes = { ...attrs };
  let value = attrs.value || '';

  const el = {
    tagName: tagName.toUpperCase(),
    type: attrs.type || '',
    id: attrs.id || '',
    name: attrs.name || '',
    disabled: attrs.disabled || false,
    checked: attrs.checked || false,
    innerText: attrs.innerText || '',
    offsetParent: attrs.hidden ? null : {},
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
    getAttribute: (name) => attributes[name] || (name === 'value' ? value : null),
    setAttribute: (name, val) => { attributes[name] = String(val); },
    hasAttribute: (name) => name in attributes,
    click: () => {
      if (el.type === 'checkbox') el.checked = !el.checked;
      if (listeners['click']) listeners['click']({ target: el });
    },
    addEventListener: (evt, fn) => {
      listeners[evt] = fn;
    },
    dispatchEvent: (evt) => {
      if (listeners[evt.type]) listeners[evt.type](evt);
      return true;
    },
    closest: (sel) => {
      if (sel === '#inline-auto-sniper-panel') return attrs.inPanel ? { id: 'inline-auto-sniper-panel' } : null;
      return { innerText: attrs.parentText || el.innerText };
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  // Give value getter and setter
  Object.defineProperty(el, 'value', {
    get() { return value; },
    set(v) { value = String(v); },
    configurable: true,
  });

  return el;
}

function createMockDocument(elements = []) {
  return {
    querySelectorAll(selector) {
      if (selector.includes('[data-date]')) {
        return elements.filter((e) =>
          e.hasAttribute('data-date') ||
          e.tagName === 'BUTTON' ||
          e.getAttribute('role') === 'button'
        );
      }
      if (selector.includes('table-tag') || selector.includes('data-cy') || selector.includes('data-testid')) {
        return elements.filter((e) => (e.getAttribute && (e.getAttribute('data-cy')?.includes('table-tag') || e.getAttribute('data-testid'))) || e.id === 'table-tag-selector' || e.tagName === 'BUTTON');
      }
      if (selector.includes('checkbox')) {
        return elements.filter((e) => e.type === 'checkbox' || e.getAttribute('role') === 'checkbox');
      }
      if (selector.includes('button')) {
        return elements.filter((e) => e.tagName === 'BUTTON' || e.getAttribute('role') === 'button' || (e.classList && e.classList.contains('time-slot')));
      }
      if (selector.includes('data-date')) {
        return elements.filter((e) => e.hasAttribute('data-date'));
      }
      return elements;
    },
    querySelector(selector) {
      if (selector.includes('target-date')) {
        return elements.find((e) => e.getAttribute('data-cy') === 'target-date') || null;
      }
      if (selector.includes('#date-picker') || selector.includes('[data-cy="date-picker"]')) {
        return elements.find((e) => e.id === 'date-picker' || e.getAttribute('data-cy') === 'date-picker') || null;
      }
      if (selector.includes('iframe')) {
        return elements.find((e) => e.tagName === 'IFRAME') || null;
      }
      if (selector.includes('#adult-picker') || selector.includes('select[name="adult"]')) {
        return elements.find((e) => e.id === 'adult-picker' || e.name === 'adult') || null;
      }
      if (selector.includes('#kid-picker') || selector.includes('select[name="kid"]')) {
        return elements.find((e) => e.id === 'kid-picker' || e.name === 'kid') || null;
      }
      if (selector.includes('submit')) {
        return elements.find((e) => (e.innerText && /完成預訂|確認/i.test(e.innerText)) || e.id === 'submit-btn') || null;
      }
      if (selector.includes('familyName')) {
        return elements.find((e) => e.id === 'familyName' || e.name === 'familyName' || e.getAttribute('data-cy') === 'familyName') || null;
      }
      if (selector.includes('givenName')) {
        return elements.find((e) => e.id === 'givenName' || e.name === 'givenName' || e.getAttribute('data-cy') === 'givenName') || null;
      }
      if (selector.includes('phone')) {
        return elements.find((e) => e.id === 'phone' || e.name === 'phone' || e.type === 'tel') || null;
      }
      if (selector.includes('email')) {
        return elements.find((e) => e.id === 'email' || e.name === 'email' || e.type === 'email') || null;
      }
      if (selector.includes('name')) {
        return elements.find((e) => e.id === 'name' || e.name === 'name' || e.getAttribute('data-cy') === 'name') || null;
      }
      return null;
    },
    getElementById(id) {
      return elements.find((e) => e.id === id) || null;
    },
  };
}

describe('InlineDomAdapter Unit Tests (Issue #3)', () => {
  // Import adapter factory from userscript
  const { createInlineDomAdapter, createSnipingEngine } = require('../inline-reservation-bot.user.js');

  it('exports createInlineDomAdapter factory', () => {
    assert.equal(typeof createInlineDomAdapter, 'function');
  });

  describe('acknowledgeHouseRules()', () => {
    it('automatically ticks terms checkboxes and clicks confirm button', () => {
      const checkbox = createMockElement('input', {
        type: 'checkbox',
        checked: false,
        parentText: '我已閱讀並同意規則與注意事項',
      });
      const confirmButton = createMockElement('button', {
        innerText: '我已閱讀並同意',
      });

      const doc = createMockDocument([checkbox, confirmButton]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const handled = adapter.acknowledgeHouseRules();
      assert.equal(handled, true);
      assert.equal(checkbox.checked, true);
    });
  });

  describe('setPartySize()', () => {
    it('sets select value and dispatches bubbling change event', () => {
      let changeDispatched = false;
      const adultPicker = createMockElement('select', { id: 'adult-picker', value: '1' });
      adultPicker.addEventListener('change', () => {
        changeDispatched = true;
      });

      const doc = createMockDocument([adultPicker]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      adapter.setPartySize(4, 1);
      assert.equal(adultPicker.value, '4');
      assert.equal(changeDispatched, true);
    });
  });

  describe('selectDate()', () => {
    it('clicks a rendered target date without reporting success before the DOM confirms selection', () => {
      let clicked = false;
      const dateButton = createMockElement('button', {
        'data-date': '2026-09-01',
      });
      dateButton.addEventListener('click', () => {
        clicked = true;
      });

      const doc = createMockDocument([dateButton]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const success = adapter.selectDate('2026-09-01');
      assert.equal(success, false);
      assert.equal(clicked, true);
    });

    it('returns false when target date is not rendered', () => {
      const doc = createMockDocument([]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const success = adapter.selectDate('2026-09-15');
      assert.equal(success, false);
    });

    it('accepts a rendered target date that is already selected and therefore not clickable', () => {
      let clickCount = 0;
      const selectedDate = createMockElement('button', {
        'data-date': '2026-09-18',
        'aria-selected': 'true',
        disabled: true,
      });
      selectedDate.addEventListener('click', () => {
        clickCount++;
      });

      const doc = createMockDocument([selectedDate]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const success = adapter.selectDate('2026-09-18');

      assert.equal(success, true);
      assert.equal(clickCount, 0);
    });

    it('accepts the target date confirmed by the real inline target-date summary', () => {
      const selectedDateSummary = createMockElement('button', {
        'data-cy': 'target-date',
        innerText: '2026年9月18日',
      });
      const hiddenTargetDay = createMockElement('div', {
        'data-cy': 'bt-cal-day',
        'data-date': '2026-09-18',
        hidden: true,
        innerText: '18',
      });

      const doc = createMockDocument([selectedDateSummary, hiddenTargetDay]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      assert.equal(adapter.selectDate('2026-09-18'), true);
    });

    it('opens the real inline date picker before attempting to click a hidden target day', () => {
      const datePicker = createMockElement('div', {
        id: 'date-picker',
        'data-cy': 'date-picker',
        'aria-expanded': 'false',
        innerText: '9月1日週二 (今日)',
      });
      const selectedDateSummary = createMockElement('button', {
        'data-cy': 'target-date',
        innerText: '2026年9月1日',
      });
      const hiddenTargetDay = createMockElement('div', {
        'data-cy': 'bt-cal-day',
        'data-date': '2026-09-18',
        hidden: true,
        innerText: '18',
      });
      datePicker.addEventListener('click', () => {
        datePicker.setAttribute('aria-expanded', 'true');
        hiddenTargetDay.offsetParent = {};
      });

      const doc = createMockDocument([datePicker, selectedDateSummary, hiddenTargetDay]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      assert.equal(adapter.selectDate('2026-09-18'), false);
      assert.equal(datePicker.getAttribute('aria-expanded'), 'true');
    });
  });

  describe('reloadPage()', () => {
    it('delegates a real page reload through the adapter seam', () => {
      let reloadCount = 0;
      const adapter = createInlineDomAdapter({
        document: createMockDocument([]),
        reload: () => {
          reloadCount++;
        },
        logger: () => {},
      });

      assert.equal(adapter.reloadPage(), true);
      assert.equal(reloadCount, 1);
    });
  });

  describe('selectTableType()', () => {
    it('defaults to selecting the first available table type when no preference is provided', () => {
      let clickedTag = null;
      const tagGeneral = createMockElement('button', {
        'data-cy': 'table-tag--OuzJIKI7Hef82q8GpXM',
        'data-testid': '-OuzJIKI7Hef82q8GpXM',
        innerText: '一般',
      });
      tagGeneral.addEventListener('click', () => {
        clickedTag = '一般';
      });
      const tagBar = createMockElement('button', {
        'data-cy': 'table-tag--OuuNua-LxXCiiJxkAmW',
        'data-testid': '-OuuNua-LxXCiiJxkAmW',
        innerText: '板前吧台',
      });
      tagBar.addEventListener('click', () => {
        clickedTag = '板前吧台';
      });

      const doc = createMockDocument([tagGeneral, tagBar]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const selected = adapter.selectTableType([]);
      assert.equal(selected, '一般');
      assert.equal(clickedTag, '一般');
    });

    it('selects preferred table type (e.g. 板前吧台) when matched', () => {
      let clickedTag = null;
      const tagGeneral = createMockElement('button', {
        'data-cy': 'table-tag-general',
        innerText: '一般',
      });
      tagGeneral.addEventListener('click', () => {
        clickedTag = '一般';
      });
      const tagBar = createMockElement('button', {
        'data-cy': 'table-tag-bar',
        innerText: '板前吧台',
      });
      tagBar.addEventListener('click', () => {
        clickedTag = '板前吧台';
      });

      const doc = createMockDocument([tagGeneral, tagBar]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const selected = adapter.selectTableType(['板前吧台']);
      assert.equal(selected, '板前吧台');
      assert.equal(clickedTag, '板前吧台');
    });

    it('matches reversed table names such as 高雄店 吧台板前 when user inputs 板前吧台', () => {
      let clickedTag = null;
      const tagGeneral = createMockElement('button', {
        'data-cy': 'table-tag--Ouq8xpdoxxy-HgR9Ldj',
        innerText: '一般',
      });
      const tagBarReversed = createMockElement('button', {
        'data-cy': 'table-tag--OuqAmoACDEpncqcC2W0',
        innerText: '吧台板前', // 高雄漢神店的顛倒名稱
      });
      tagBarReversed.addEventListener('click', () => {
        clickedTag = '吧台板前';
      });

      const doc = createMockDocument([tagGeneral, tagBarReversed]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const selected = adapter.selectTableType(['板前吧台']);
      assert.equal(selected, '吧台板前');
      assert.equal(clickedTag, '吧台板前');
    });

    it('returns null when no table selector exists on the page', () => {
      const doc = createMockDocument([]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const selected = adapter.selectTableType([]);
      assert.equal(selected, null);
    });
  });

  describe('claimSlot() with DOM button fixtures', () => {
    it('clicks the available slot button matching priority list', () => {
      let clickedSlot = null;
      const slot1 = createMockElement('button', {
        innerText: '18:00 (已滿)',
        className: 'time-slot disabled',
        disabled: true,
      });
      const slot2 = createMockElement('button', {
        innerText: '19:00',
        className: 'time-slot',
      });
      slot2.addEventListener('click', () => {
        clickedSlot = '19:00';
      });

      const doc = createMockDocument([slot1, slot2]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const claimed = adapter.claimSlot(['19:00', '20:00']);
      assert.equal(claimed, '19:00');
      assert.equal(clickedSlot, '19:00');
    });

    it('waits for an asynchronously selected target date before claiming its Time Slot', async () => {
      let selectedDate = '2026-09-01';
      let claimedForDate = null;

      const targetDate = createMockElement('button', {
        'data-date': '2026-10-18',
        'aria-selected': 'false',
      });
      const slot = createMockElement('button', { innerText: '18:00' });

      targetDate.addEventListener('click', () => {
        setTimeout(() => {
          targetDate.setAttribute('aria-selected', 'true');
          targetDate.disabled = true;
          selectedDate = '2026-10-18';
        }, 0);
      });
      slot.addEventListener('click', () => {
        claimedForDate = selectedDate;
      });

      const doc = createMockDocument([targetDate, slot]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });
      adapter.submitReservation = async () => ({ success: true, status: 'CONFIRMED' });

      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          targetDate: '2026-10-18',
          adults: '4',
          kids: '0',
          prioritySlots: '18:00',
        }),
        logger: () => {},
        onStatusUpdate: () => {},
        onNotify: () => {},
      });

      engine.triggerDropAction();
      await new Promise((resolve) => setTimeout(resolve, 180));
      engine.stop();

      assert.equal(claimedForDate, '2026-10-18');
    });

    it('opens the collapsed inline date picker and confirms its target-date summary before claiming a Time Slot', async () => {
      let selectedDate = '2026-09-01';
      let claimedForDate = null;

      const datePicker = createMockElement('div', {
        id: 'date-picker',
        'data-cy': 'date-picker',
        'aria-expanded': 'false',
        innerText: '9月1日週二 (今日)',
      });
      const selectedDateSummary = createMockElement('button', {
        'data-cy': 'target-date',
        innerText: '2026年9月1日',
      });
      const targetDay = createMockElement('div', {
        'data-cy': 'bt-cal-day',
        'data-date': '2026-09-18',
        hidden: true,
        innerText: '18',
      });
      const slot = createMockElement('button', { innerText: '18:00' });

      datePicker.addEventListener('click', () => {
        datePicker.setAttribute('aria-expanded', 'true');
        targetDay.offsetParent = {};
      });
      targetDay.addEventListener('click', () => {
        setTimeout(() => {
          selectedDateSummary.innerText = '2026年9月18日';
          selectedDate = '2026-09-18';
          datePicker.setAttribute('aria-expanded', 'false');
          targetDay.offsetParent = null;
        }, 0);
      });
      slot.addEventListener('click', () => {
        claimedForDate = selectedDate;
      });

      const doc = createMockDocument([datePicker, selectedDateSummary, targetDay, slot]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });
      adapter.selectTableType = () => null;
      adapter.submitReservation = async () => ({ success: true, status: 'CONFIRMED' });

      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          targetDate: '2026-09-18',
          adults: '4',
          kids: '0',
          prioritySlots: '18:00',
        }),
        logger: () => {},
        onStatusUpdate: () => {},
        onNotify: () => {},
      });

      engine.triggerDropAction();
      await new Promise((resolve) => setTimeout(resolve, 320));
      engine.stop();

      assert.equal(claimedForDate, '2026-09-18');
    });

    it('finishes a collapsed date-picker transition during Cancellation Sniping before reloading', async (t) => {
      let selectedDate = '2026-09-01';
      let claimedForDate = null;
      let reloadCount = 0;

      const datePicker = createMockElement('div', {
        id: 'date-picker',
        'data-cy': 'date-picker',
        'aria-expanded': 'false',
        innerText: '9月1日週二 (今日)',
      });
      const selectedDateSummary = createMockElement('button', {
        'data-cy': 'target-date',
        innerText: '2026年9月1日',
      });
      const targetDay = createMockElement('div', {
        'data-cy': 'bt-cal-day',
        'data-date': '2026-09-18',
        hidden: true,
        innerText: '18',
      });
      const slot = createMockElement('button', { innerText: '18:00' });

      datePicker.addEventListener('click', () => {
        datePicker.setAttribute('aria-expanded', 'true');
        targetDay.offsetParent = {};
      });
      targetDay.addEventListener('click', () => {
        setTimeout(() => {
          selectedDateSummary.innerText = '2026年9月18日';
          selectedDate = '2026-09-18';
        }, 0);
      });
      slot.addEventListener('click', () => {
        claimedForDate = selectedDate;
      });

      const adapter = createInlineDomAdapter({
        document: createMockDocument([datePicker, selectedDateSummary, targetDay, slot]),
        reload: () => {
          reloadCount++;
        },
        logger: () => {},
      });
      adapter.selectTableType = () => null;
      adapter.submitReservation = async () => ({ success: true, status: 'CONFIRMED' });

      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          mode: 'cancellation',
          pollIntervalMin: 5,
          pollIntervalMax: 5,
          targetDate: '2026-09-18',
          adults: '4',
          kids: '0',
          prioritySlots: '18:00',
        }),
        cancellationDateRetryIntervalMs: 5,
        cancellationDateRetryLimit: 4,
        logger: () => {},
        onStatusUpdate: () => {},
        onNotify: () => {},
      });
      t.after(() => engine.stop());

      engine.start();
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.equal(claimedForDate, '2026-09-18');
      assert.equal(reloadCount, 0);
    });
  });

  describe('submitReservation() with DOM form fixtures', () => {
    it('populates inputs using prototype setters and clicks confirmation button', async () => {
      const nameInput = createMockElement('input', { id: 'name', value: '' });
      const phoneInput = createMockElement('input', { id: 'phone', value: '' });
      const emailInput = createMockElement('input', { id: 'email', value: '' });
      const submitBtn = createMockElement('button', {
        id: 'submit-btn',
        innerText: '確認訂位',
      });

      let submitted = false;
      submitBtn.addEventListener('click', () => {
        submitted = true;
      });

      const doc = createMockDocument([nameInput, phoneInput, emailInput, submitBtn]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const result = await adapter.submitReservation({
        name: '王小明',
        phone: '0912345678',
        email: 'wang@example.com',
      }, { autoSubmit: true });

      assert.equal(result.success, true);
      assert.equal(result.status, 'CONFIRMED');
      assert.equal(nameInput.value, '王小明');
      assert.equal(phoneInput.value, '0912345678');
      assert.equal(submitted, true);
    });

    it('populates familyName and givenName separately when customerNameFields is 2 (e.g. Island Buffet)', async () => {
      const familyNameInput = createMockElement('input', { id: 'familyName', 'data-cy': 'familyName', value: '' });
      const givenNameInput = createMockElement('input', { id: 'givenName', 'data-cy': 'givenName', value: '' });
      const phoneInput = createMockElement('input', { id: 'phone', value: '' });
      const emailInput = createMockElement('input', { id: 'email', value: '' });
      const submitBtn = createMockElement('button', {
        id: 'submit-btn',
        innerText: '確認訂位',
      });

      let submitted = false;
      submitBtn.addEventListener('click', () => {
        submitted = true;
      });

      const doc = createMockDocument([familyNameInput, givenNameInput, phoneInput, emailInput, submitBtn]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const result = await adapter.submitReservation({
        name: '王小明',
        phone: '0912345678',
        email: 'wang@example.com',
      }, { autoSubmit: true });

      assert.equal(result.success, true);
      assert.equal(result.status, 'CONFIRMED');
      assert.equal(familyNameInput.value, '王');
      assert.equal(givenNameInput.value, '小明');
      assert.equal(submitted, true);
    });
  });

  describe('Credit Card Deposit Policy Guard', () => {
    it('detects credit card iframe and flags deposit requirement', () => {
      const iframe = createMockElement('iframe', {
        src: 'https://tappay.inline.app/card',
      });
      const doc = createMockDocument([iframe]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      assert.equal(adapter.hasCreditCardDeposit(), true);
    });
  });
});
