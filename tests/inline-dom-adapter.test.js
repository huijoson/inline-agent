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
    closest: () => ({ innerText: attrs.parentText || el.innerText }),
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
      if (selector.includes('phone')) {
        return elements.find((e) => e.id === 'phone' || e.name === 'phone') || null;
      }
      if (selector.includes('email')) {
        return elements.find((e) => e.id === 'email' || e.name === 'email') || null;
      }
      if (selector.includes('name')) {
        return elements.find((e) => e.id === 'name' || e.name === 'name') || null;
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
  const { createInlineDomAdapter } = require('../inline-reservation-bot.user.js');

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
    it('locates and clicks corresponding data-date element', () => {
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
      assert.equal(success, true);
      assert.equal(clicked, true);
    });

    it('returns false when target date is not rendered', () => {
      const doc = createMockDocument([]);
      const adapter = createInlineDomAdapter({ document: doc, logger: () => {} });

      const success = adapter.selectDate('2026-09-15');
      assert.equal(success, false);
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
