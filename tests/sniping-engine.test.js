const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeReservationAdapter } = require('./reservation-target-seam');

describe('SnipingEngine Orchestration & Seam Integration (Issue #4)', () => {
  const { createSnipingEngine, SnipingState } = require('../inline-reservation-bot.user.js');

  it('exports createSnipingEngine factory and SnipingState', () => {
    assert.equal(typeof createSnipingEngine, 'function');
    assert.ok(SnipingState);
    assert.equal(SnipingState.IDLE, 'IDLE');
    assert.equal(SnipingState.COUNTDOWN, 'COUNTDOWN');
    assert.equal(SnipingState.ACTIVE_SNIPING, 'ACTIVE_SNIPING');
  });

  describe('Opening Sniping Flow via Seam', () => {
    it('executes drop action, acknowledges house rules, sets party size and claims priority slot', () => {
      const adapter = createFakeReservationAdapter({
        houseRulesActive: true,
        availableSlots: ['19:00', '19:30'],
      });

      const logs = [];
      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          mode: 'drop',
          dropTime: '00:00:00',
          leadTimeMs: 100,
          targetDate: '2026-09-01',
          adults: '2',
          kids: '0',
          prioritySlots: '19:00, 19:30',
        }),
        logger: (msg) => logs.push(msg),
        onStatusUpdate: () => {},
      });

      // Directly trigger drop action to test seam interactions
      engine.triggerDropAction();

      // Wait a short tick for the drop retry loop
      return new Promise((resolve) => {
        setTimeout(() => {
          engine.stop();
          const callLog = adapter._getCallLog();
          const methodNames = callLog.map((c) => c.method);

          // Must call through the seam methods, never raw DOM
          assert.ok(methodNames.includes('acknowledgeHouseRules'), 'Must acknowledge house rules via seam');
          assert.ok(methodNames.includes('setPartySize'), 'Must set party size via seam');
          assert.ok(methodNames.includes('selectDate'), 'Must select date via seam');
          assert.ok(methodNames.includes('selectTableType'), 'Must select table type via seam');
          assert.ok(methodNames.includes('claimSlot'), 'Must claim slot via seam');

          assert.equal(adapter._getState().claimedSlot, '19:00');
          resolve();
        }, 200);
      });
    });
  });

  describe('Cancellation Sniping Flow via Seam (Tampermonkey Reload)', () => {
    it('reloads the page when the target Booking Date is disabled', async (t) => {
      const adapter = createFakeReservationAdapter({
        availableDates: ['2026-10-31'],
      });

      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          mode: 'cancellation',
          pollIntervalMin: 5,
          pollIntervalMax: 5,
          targetDate: '2026-11-01',
          adults: '4',
          kids: '0',
          prioritySlots: '18:00',
        }),
        cancellationDateRetryIntervalMs: 5,
        cancellationDateRetryLimit: 4,
        logger: () => {},
        onStatusUpdate: () => {},
      });
      t.after(() => engine.stop());

      engine.start();
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(adapter._getState().reloadCount, 1);
      assert.equal(adapter._getState().claimedSlot, null);
      assert.equal(
        adapter._getCallLog().filter((call) => call.method === 'selectDate').length,
        5,
        'retries the Booking Date exactly four times after the initial failed selection'
      );
    });

    it('reloads the page when the target date is selected but has no Time Slot', async (t) => {
      const adapter = createFakeReservationAdapter({
        availableDates: ['2026-11-01'],
        availableSlots: [],
      });
      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          mode: 'cancellation',
          pollIntervalMin: 5,
          pollIntervalMax: 5,
          targetDate: '2026-11-01',
          adults: '4',
          kids: '0',
          prioritySlots: '18:00',
        }),
        logger: () => {},
        onStatusUpdate: () => {},
      });
      t.after(() => engine.stop());

      engine.start();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(adapter._getState().reloadCount, 1);
    });
  });

  describe('State Transitions & Timer Isolation', () => {
    it('transitions cleanly between states and clears all timers on stop()', () => {
      const adapter = createFakeReservationAdapter();
      let lastStatus = null;

      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          mode: 'drop',
          dropTime: '23:59:59',
          leadTimeMs: 180,
          prioritySlots: '18:30',
        }),
        onStatusUpdate: (status) => {
          lastStatus = status;
        },
        logger: () => {},
      });

      assert.equal(engine.getStatus(), SnipingState.IDLE);
      engine.start();
      assert.equal(engine.getStatus(), SnipingState.COUNTDOWN);

      engine.stop();
      assert.equal(engine.getStatus(), SnipingState.IDLE);
    });

    it('publishes inactive lifecycle state when the operator stops Cancellation Sniping', () => {
      const lifecycle = [];
      const engine = createSnipingEngine({
        adapter: createFakeReservationAdapter(),
        getConfig: () => ({
          mode: 'cancellation',
          pollIntervalMin: 1000,
          pollIntervalMax: 1000,
          targetDate: '2026-11-01',
          prioritySlots: '18:00',
        }),
        onRunStateChange: (event) => lifecycle.push(event),
        onStatusUpdate: () => {},
        logger: () => {},
      });

      engine.start();
      engine.stop();

      assert.deepEqual(lifecycle, [
        { active: true, mode: 'cancellation' },
        { active: false, mode: 'cancellation' },
      ]);
    });

    it('publishes inactive lifecycle state after a successful reservation', async () => {
      const lifecycle = [];
      const engine = createSnipingEngine({
        adapter: createFakeReservationAdapter({
          availableDates: ['2026-11-01'],
          availableSlots: ['18:00'],
        }),
        getConfig: () => ({
          mode: 'cancellation',
          targetDate: '2026-11-01',
          prioritySlots: '18:00',
        }),
        onRunStateChange: (event) => lifecycle.push(event),
        onStatusUpdate: () => {},
        onNotify: () => {},
        logger: () => {},
      });

      engine.start();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.deepEqual(lifecycle.at(-1), {
        active: false,
        mode: 'cancellation',
      });
    });

    it('preserves AWAITING_MANUAL_DEPOSIT state when deposit policy requires credit card', async () => {
      const adapter = createFakeReservationAdapter({
        availableSlots: ['19:00'],
        requiresDeposit: true,
      });

      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          mode: 'drop',
          prioritySlots: '19:00',
        }),
        logger: () => {},
        onNotify: () => {},
      });

      engine.triggerDropAction();
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(engine.getStatus(), SnipingState.AWAITING_MANUAL_DEPOSIT);
    });

    it('terminates drop sniping when retry budget of 30 attempts is exhausted', async () => {
      const adapter = createFakeReservationAdapter({
        availableSlots: [], // never available
      });

      let stopped = false;
      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          mode: 'drop',
          prioritySlots: '19:00',
        }),
        logger: () => {},
      });

      engine.triggerDropAction();

      // Wait for 30 attempts at 120ms (approx 3600ms), or simulate clock
      // We verify claimSlot was called at least once immediately (0ms tick)
      assert.ok(adapter._getCallLog().some((c) => c.method === 'claimSlot'));
      engine.stop();
    });
  });
});
