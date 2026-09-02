const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  createRuntimeStateStore,
  createSnipingEngine,
  resumePersistedCancellation,
  SnipingState,
} = require('../inline-reservation-bot.user.js');
const { createFakeReservationAdapter } = require('./reservation-target-seam');

function createMemoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
}

describe('Tampermonkey cancellation runtime state', () => {
  it('reports successful activation and deactivation', () => {
    const store = createRuntimeStateStore(createMemoryStorage());

    assert.equal(store.activate('https://inline.app/booking/shop-a'), true);
    assert.equal(store.deactivate(), true);
  });

  it('persists whether Cancellation Sniping is monitoring or submitting', () => {
    const store = createRuntimeStateStore(createMemoryStorage());
    const bookingTarget = 'https://inline.app/booking/shop-a';

    store.activate(bookingTarget, 'submitting');

    assert.deepEqual(store.load(), {
      active: true,
      mode: 'cancellation',
      bookingTarget,
      phase: 'submitting',
    });
  });

  it('treats active runtime state from version 2.2.0 as monitoring', () => {
    const bookingTarget = 'https://inline.app/booking/shop-a';
    const storage = createMemoryStorage({
      INLINE_SNIPER_RUNTIME_V1: JSON.stringify({
        active: true,
        mode: 'cancellation',
        bookingTarget,
      }),
    });
    const store = createRuntimeStateStore(storage);

    assert.equal(store.load().phase, 'monitoring');
  });

  it('returns false instead of throwing when activation storage fails', () => {
    const store = createRuntimeStateStore({
      getItem: () => null,
      setItem() {
        throw new DOMException('Storage is blocked', 'SecurityError');
      },
      removeItem: () => {},
    });

    assert.doesNotThrow(() => {
      assert.equal(store.activate('https://inline.app/booking/shop-a'), false);
    });
  });

  it('returns false instead of throwing when deactivation storage fails', () => {
    const store = createRuntimeStateStore({
      getItem: () => null,
      setItem: () => {},
      removeItem() {
        throw new DOMException('Storage quota unavailable', 'QuotaExceededError');
      },
    });

    assert.doesNotThrow(() => {
      assert.equal(store.deactivate(), false);
    });
  });

  it('loads without crashing when browser localStorage acquisition throws', () => {
    const userscriptPath = path.resolve(__dirname, '../inline-reservation-bot.user.js');
    const probe = `
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('Storage is blocked', 'SecurityError');
        },
      });
      require(process.argv[1]);
    `;

    const result = spawnSync(process.execPath, ['-e', probe, userscriptPath], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
  });

  it('resumes an active cancellation run only on the exact Booking Target', () => {
    const store = createRuntimeStateStore(createMemoryStorage());
    const bookingTarget = 'https://inline.app/booking/shop-a?language=zh-tw';

    store.activate(bookingTarget);

    assert.equal(store.shouldResume(bookingTarget), true);
    assert.equal(
      store.shouldResume('https://inline.app/booking/shop-b?language=zh-tw'),
      false
    );
  });

  it('does not resume after explicit deactivation', () => {
    const store = createRuntimeStateStore(createMemoryStorage());
    const bookingTarget = 'https://inline.app/booking/shop-a';

    store.activate(bookingTarget);
    store.deactivate();

    assert.equal(store.shouldResume(bookingTarget), false);
  });

  it('treats malformed persisted state as inactive', () => {
    const storage = createMemoryStorage({
      INLINE_SNIPER_RUNTIME_V1: '{broken',
    });
    const store = createRuntimeStateStore(storage);

    assert.deepEqual(store.load(), {
      active: false,
      mode: null,
      bookingTarget: '',
      phase: null,
    });
  });

  it('starts Cancellation Sniping after Tampermonkey reinjects on the same Booking Target', () => {
    const store = createRuntimeStateStore(createMemoryStorage());
    const bookingTarget = 'https://inline.app/booking/shop-a?language=zh-tw';
    let startCount = 0;
    store.activate(bookingTarget);

    const resumed = resumePersistedCancellation({
      store,
      bookingTarget,
      mode: 'cancellation',
      start: () => {
        startCount++;
      },
      logger: () => {},
    });

    assert.equal(resumed, true);
    assert.equal(startCount, 1);
  });

  it('resumes monitoring after polling reload without treating a contact form as a claimed Time Slot', async (t) => {
    const store = createRuntimeStateStore(createMemoryStorage());
    const bookingTarget = 'https://inline.app/booking/shop-a';
    const adapter = createFakeReservationAdapter({
      isContactFormPage: true,
      availableDates: ['2026-11-01'],
      availableSlots: [],
    });
    store.activate(bookingTarget, 'monitoring');

    const engine = createSnipingEngine({
      adapter,
      getConfig: () => ({
        mode: 'cancellation',
        targetDate: '2026-11-01',
        adults: '2',
        kids: '0',
        prioritySlots: '18:00',
        pollIntervalMin: 5,
        pollIntervalMax: 5,
      }),
      onRunStateChange: ({ active, phase }) => active
        ? store.activate(bookingTarget, phase)
        : store.deactivate(),
      onStatusUpdate: () => {},
      onNotify: () => {},
      logger: () => {},
    });
    t.after(() => engine.stop());

    const resumed = resumePersistedCancellation({
      store,
      bookingTarget,
      mode: 'cancellation',
      start: (resumeState) => engine.start(resumeState),
      logger: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(resumed, true);
    assert.equal(adapter._getState().reloadCount, 1);
    assert.equal(adapter._getState().submittedReservation, null);
    assert.equal(store.shouldResume(bookingTarget), true);
  });

  it('resumes submission after a claimed Time Slot even before the contact form finishes rendering', async (t) => {
    const store = createRuntimeStateStore(createMemoryStorage());
    const bookingTarget = 'https://inline.app/booking/shop-a';
    const adapter = createFakeReservationAdapter({
      isContactFormPage: false,
      availableDates: ['2026-11-01'],
      availableSlots: [],
    });
    store.activate(bookingTarget, 'submitting');

    const engine = createSnipingEngine({
      adapter,
      getConfig: () => ({
        mode: 'cancellation',
        targetDate: '2026-11-01',
        adults: '2',
        kids: '0',
        prioritySlots: '18:00',
        pollIntervalMin: 5,
        pollIntervalMax: 5,
      }),
      onRunStateChange: ({ active, phase }) => active
        ? store.activate(bookingTarget, phase)
        : store.deactivate(),
      onStatusUpdate: () => {},
      onNotify: () => {},
      logger: () => {},
    });
    t.after(() => engine.stop());

    const resumed = resumePersistedCancellation({
      store,
      bookingTarget,
      mode: 'cancellation',
      start: (resumeState) => engine.start(resumeState),
      logger: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(resumed, true);
    assert.ok(adapter._getState().submittedReservation);
    assert.equal(adapter._getState().reloadCount, 0);
  });

  it('persists the submitting phase as soon as Cancellation Sniping claims a Time Slot', async (t) => {
    const store = createRuntimeStateStore(createMemoryStorage());
    const bookingTarget = 'https://inline.app/booking/shop-a';
    const adapter = createFakeReservationAdapter({
      availableDates: ['2026-11-01'],
      availableSlots: ['18:00'],
      submissionDelayMs: 50,
    });
    const engine = createSnipingEngine({
      adapter,
      getConfig: () => ({
        mode: 'cancellation',
        targetDate: '2026-11-01',
        adults: '2',
        kids: '0',
        prioritySlots: '18:00',
        pollIntervalMin: 5,
        pollIntervalMax: 5,
      }),
      onRunStateChange: ({ active, phase }) => active
        ? store.activate(bookingTarget, phase)
        : store.deactivate(),
      onStatusUpdate: () => {},
      onNotify: () => {},
      logger: () => {},
    });
    t.after(() => engine.stop());

    engine.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(store.load().phase, 'submitting');
  });

  it('reports resume failure when delegated Cancellation startup fails', () => {
    const store = createRuntimeStateStore(createMemoryStorage());
    const bookingTarget = 'https://inline.app/booking/shop-a';
    store.activate(bookingTarget);

    const resumed = resumePersistedCancellation({
      store,
      bookingTarget,
      mode: 'cancellation',
      start: () => false,
      logger: () => {},
    });

    assert.equal(resumed, false);
  });

  it('aborts Cancellation startup before work or reload when activation fails', async (t) => {
    const adapter = createFakeReservationAdapter({
      availableDates: ['2026-11-02'],
    });
    const statuses = [];
    const logs = [];
    const engine = createSnipingEngine({
      adapter,
      getConfig: () => ({
        mode: 'cancellation',
        targetDate: '2026-11-01',
        pollIntervalMin: 1,
        pollIntervalMax: 1,
      }),
      cancellationDateRetryIntervalMs: 1,
      cancellationDateRetryLimit: 0,
      onRunStateChange: ({ active }) => active ? false : true,
      onStatusUpdate: (displayText, timeText, running) => {
        statuses.push({ displayText, timeText, running });
      },
      logger: (message) => logs.push(message),
    });
    t.after(() => engine.stop());

    assert.equal(engine.start(), false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(engine.getStatus(), SnipingState.IDLE);
    assert.equal(statuses.at(-1).running, false);
    assert.ok(logs.some((message) => message.includes('無法啟動')));
    assert.equal(adapter._getCallLog().length, 0);
    assert.equal(adapter._getState().reloadCount, 0);
  });

  it('keeps Opening startup and Stop usable when deactivation reports failure', (t) => {
    const engine = createSnipingEngine({
      adapter: createFakeReservationAdapter(),
      getConfig: () => ({
        mode: 'drop',
        dropTime: '23:59:59',
      }),
      onRunStateChange: () => false,
      onStatusUpdate: () => {},
      logger: () => {},
    });
    t.after(() => engine.stop());

    assert.equal(engine.start(), true);
    assert.equal(engine.getStatus(), SnipingState.COUNTDOWN);
    assert.doesNotThrow(() => engine.stop());
    assert.equal(engine.getStatus(), SnipingState.IDLE);
  });

  it('does not start on another Booking Target or in Opening Sniping mode', () => {
    const store = createRuntimeStateStore(createMemoryStorage());
    store.activate('https://inline.app/booking/shop-a');
    let startCount = 0;
    const start = () => {
      startCount++;
    };

    assert.equal(resumePersistedCancellation({
      store,
      bookingTarget: 'https://inline.app/booking/shop-b',
      mode: 'cancellation',
      start,
      logger: () => {},
    }), false);
    assert.equal(resumePersistedCancellation({
      store,
      bookingTarget: 'https://inline.app/booking/shop-a',
      mode: 'drop',
      start,
      logger: () => {},
    }), false);
    assert.equal(startCount, 0);
  });
});
