const { it } = require('node:test');
const assert = require('node:assert/strict');

const {
  clearSiteCacheWithSnipingStopped,
  createRuntimeStateStore,
  createSnipingEngine,
  SnipingState,
} = require('../inline-reservation-bot.user.js');
const { createFakeReservationAdapter } = require('./reservation-target-seam');

function createMemoryStorage() {
  const entries = new Map();
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
    clear() {
      entries.clear();
    },
  };
}

it('stops active Cancellation Sniping and updates UI before clearing site storage', async (t) => {
  assert.equal(typeof clearSiteCacheWithSnipingStopped, 'function');

  const bookingTarget = 'https://inline.app/booking/shop-a';
  const storage = createMemoryStorage();
  const runtimeStore = createRuntimeStateStore(storage);
  const statuses = [];
  const engine = createSnipingEngine({
    adapter: createFakeReservationAdapter(),
    getConfig: () => ({
      mode: 'cancellation',
      targetDate: '2026-11-01',
      prioritySlots: '18:00',
      pollIntervalMin: 1000,
      pollIntervalMax: 1000,
    }),
    onRunStateChange: ({ active }) => active
      ? runtimeStore.activate(bookingTarget)
      : runtimeStore.deactivate(),
    onStatusUpdate: (displayText, timeText, running) => {
      statuses.push({ displayText, timeText, running });
    },
    logger: () => {},
  });
  t.after(() => engine.stop());

  assert.equal(engine.start(), true);
  assert.equal(runtimeStore.shouldResume(bookingTarget), true);

  let lifecycleAtClear = null;
  await clearSiteCacheWithSnipingStopped({
    stopSniping: () => engine.stop(),
    clearStorage: async () => {
      lifecycleAtClear = {
        status: engine.getStatus(),
        running: statuses.at(-1).running,
        resumable: runtimeStore.shouldResume(bookingTarget),
      };
      storage.clear();
    },
  });

  assert.deepEqual(lifecycleAtClear, {
    status: SnipingState.IDLE,
    running: false,
    resumable: false,
  });
  assert.equal(engine.getStatus(), SnipingState.IDLE);
});
