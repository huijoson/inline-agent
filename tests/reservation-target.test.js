const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeReservationAdapter } = require('./reservation-target-seam');

describe('ReservationTarget Seam Contract & Invariants', () => {
  describe('House Rules Acknowledgment', () => {
    it('returns false when no house rules or terms are active', () => {
      const adapter = createFakeReservationAdapter({ houseRulesActive: false });
      const result = adapter.acknowledgeHouseRules();
      assert.equal(result, false);
      assert.equal(adapter._getState().houseRulesAcknowledgedCount, 0);
    });

    it('acknowledges and dismisses house rules when active', () => {
      const adapter = createFakeReservationAdapter({ houseRulesActive: true });
      const result = adapter.acknowledgeHouseRules();
      assert.equal(result, true);
      assert.equal(adapter._getState().houseRulesActive, false);
      assert.equal(adapter._getState().houseRulesAcknowledgedCount, 1);

      // Subsequent check should return false since rules are already acknowledged
      assert.equal(adapter.acknowledgeHouseRules(), false);
    });
  });

  describe('Party Size Configuration', () => {
    it('updates adult and child party size cleanly', () => {
      const adapter = createFakeReservationAdapter();
      adapter.setPartySize(4, 2);
      assert.deepEqual(adapter._getState().partySize, { adults: 4, kids: 2 });
    });

    it('coerces string input values to numbers', () => {
      const adapter = createFakeReservationAdapter();
      adapter.setPartySize('3', '1');
      assert.deepEqual(adapter._getState().partySize, { adults: 3, kids: 1 });
    });
  });

  describe('Target Date Selection', () => {
    it('successfully selects an open target date', () => {
      const adapter = createFakeReservationAdapter({
        availableDates: ['2026-09-01', '2026-09-02'],
      });
      const selected = adapter.selectDate('2026-09-01');
      assert.equal(selected, true);
      assert.equal(adapter._getState().selectedDate, '2026-09-01');
    });

    it('returns false if target date is not rendered or unavailable', () => {
      const adapter = createFakeReservationAdapter({
        availableDates: ['2026-09-01'],
      });
      const selected = adapter.selectDate('2026-09-15');
      assert.equal(selected, false);
      assert.equal(adapter._getState().selectedDate, null);
    });
  });

  describe('Priority Slot Sniping (claimSlot)', () => {
    it('claims the highest priority available slot in order', () => {
      const adapter = createFakeReservationAdapter({
        availableSlots: ['19:00', '20:00', '18:30'],
      });
      const priorityList = ['18:00', '18:30', '19:00', '20:00'];
      
      const claimed = adapter.claimSlot(priorityList);
      assert.equal(claimed, '18:30');
      assert.equal(adapter._getState().claimedSlot, '18:30');
    });

    it('returns null if none of the prioritized slots are available', () => {
      const adapter = createFakeReservationAdapter({
        availableSlots: ['12:00', '12:30'],
      });
      const priorityList = ['18:00', '18:30', '19:00'];
      
      const claimed = adapter.claimSlot(priorityList);
      assert.equal(claimed, null);
      assert.equal(adapter._getState().claimedSlot, null);
    });
  });

  describe('Submission Policy & Deposit Policy Enforcement', () => {
    it('halts autonomous submission immediately when Deposit Policy requires credit card', async () => {
      const adapter = createFakeReservationAdapter({
        requiresDeposit: true,
      });
      adapter.claimSlot(['19:00']);

      const result = await adapter.submitReservation(
        { name: 'Alice', phone: '0912345678', email: 'alice@example.com' },
        { autoSubmit: true }
      );

      assert.equal(result.success, false);
      assert.equal(result.status, 'DEPOSIT_REQUIRED');
      assert.equal(adapter._getState().submittedReservation, null);
    });

    it('holds submission for manual confirmation when Submission Policy autoSubmit is false', async () => {
      const adapter = createFakeReservationAdapter({
        requiresDeposit: false,
      });
      adapter.claimSlot(['19:00']);

      const result = await adapter.submitReservation(
        { name: 'Bob', phone: '0987654321', email: 'bob@example.com' },
        { autoSubmit: false }
      );

      assert.equal(result.success, false);
      assert.equal(result.status, 'HELD_FOR_MANUAL_SUBMISSION');
      assert.equal(adapter._getState().submittedReservation, null);
    });

    it('autonomously submits and confirms reservation when free and autoSubmit is enabled', async () => {
      const adapter = createFakeReservationAdapter({
        requiresDeposit: false,
        availableSlots: ['19:00'],
      });
      adapter.selectDate('2026-09-01');
      adapter.setPartySize(2, 0);
      adapter.claimSlot(['19:00']);

      const result = await adapter.submitReservation(
        { name: 'Charlie', phone: '0911223344', email: 'charlie@example.com' },
        { autoSubmit: true }
      );

      assert.equal(result.success, true);
      assert.equal(result.status, 'CONFIRMED');
      assert.equal(result.reservation.claimedSlot, '19:00');
      assert.equal(result.reservation.date, '2026-09-01');
      assert.deepEqual(result.reservation.partySize, { adults: 2, kids: 0 });
    });
  });
});
