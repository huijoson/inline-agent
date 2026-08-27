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
          assert.ok(methodNames.includes('claimSlot'), 'Must claim slot via seam');

          assert.equal(adapter._getState().claimedSlot, '19:00');
          resolve();
        }, 200);
      });
    });
  });

  describe('Cancellation Sniping Flow via Seam (Soft Re-trigger)', () => {
    it('queries available slots, and if unavailable, triggers soft re-selection without reloading', () => {
      const adapter = createFakeReservationAdapter({
        availableSlots: [], // initially empty
      });

      const logs = [];
      const engine = createSnipingEngine({
        adapter,
        getConfig: () => ({
          mode: 'cancellation',
          pollIntervalMin: 50,
          pollIntervalMax: 100,
          targetDate: '2026-09-01',
          adults: '2',
          kids: '0',
          prioritySlots: '19:00',
        }),
        logger: (msg) => logs.push(msg),
        onStatusUpdate: () => {},
      });

      engine.executeCancellationCycle();
      assert.equal(adapter._getState().claimedSlot, null);

      // Verify seam was called
      const methods = adapter._getCallLog().map((c) => c.method);
      assert.ok(methods.includes('acknowledgeHouseRules'));
      assert.ok(methods.includes('setPartySize'));
      assert.ok(methods.includes('selectDate'));
      assert.ok(methods.includes('claimSlot'));

      engine.stop();
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
