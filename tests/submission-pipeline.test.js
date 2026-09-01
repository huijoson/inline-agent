const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeReservationAdapter } = require('./reservation-target-seam');

describe('Autonomous Submission Pipeline & Deposit Policy Guard (Issue #5)', () => {
  const { createSnipingEngine, SnipingState } = require('../inline-reservation-bot.user.js');

  it('halts autonomous submission and fires alert when Deposit Policy requires credit card', async () => {
    const adapter = createFakeReservationAdapter({
      isContactFormPage: true,
      requiresDeposit: true,
      availableSlots: ['19:00'],
    });

    const notifications = [];
    const logs = [];

    const engine = createSnipingEngine({
      adapter,
      getConfig: () => ({
        mode: 'drop',
        userName: '王小明',
        userGender: 'male',
        userPhone: '0912345678',
        userEmail: 'wang@example.com',
        bookingNote: '靠窗位',
        autoSubmitFree: true,
      }),
      logger: (msg) => logs.push(msg),
      onNotify: (title, body) => notifications.push({ title, body }),
    });

    engine.start();

    // Give microtask tick for async submitReservation
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Verify engine halted in AWAITING_MANUAL_DEPOSIT state
    assert.equal(engine.getStatus(), SnipingState.AWAITING_MANUAL_DEPOSIT);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Inline 搶位提醒');
    assert.ok(notifications[0].body.includes('信用卡預授權'));
  });

  it('autonomously submits a free reservation', async () => {
    const adapter = createFakeReservationAdapter({
      isContactFormPage: true,
      requiresDeposit: false,
      availableSlots: ['19:00'],
    });

    const notifications = [];
    const logs = [];

    const engine = createSnipingEngine({
      adapter,
      getConfig: () => ({
        mode: 'cancellation',
        userName: '李小華',
        userGender: 'female',
        userPhone: '0988776655',
        userEmail: 'lee@example.com',
        bookingNote: '慶祝生日',
      }),
      logger: (msg) => logs.push(msg),
      onNotify: (title, body) => notifications.push({ title, body }),
    });

    engine.start();

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(engine.getStatus(), SnipingState.COMPLETED);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Inline 訂位完成');
    assert.ok(notifications[0].body.includes('完成預約'));

    // Check adapter recorded submission with guest details
    const submitted = adapter._getState().submittedReservation;
    assert.ok(submitted);
    assert.equal(submitted.guestDetails.name, '李小華');
    assert.equal(submitted.guestDetails.phone, '0988776655');
  });

  it('autonomously submits a free reservation even when legacy saved settings disable autoSubmitFree', async () => {
    const adapter = createFakeReservationAdapter({
      isContactFormPage: true,
      requiresDeposit: false,
      availableSlots: ['19:00'],
    });

    const notifications = [];

    const engine = createSnipingEngine({
      adapter,
      getConfig: () => ({
        userName: '張三',
        autoSubmitFree: false,
      }),
      logger: () => {},
      onNotify: (title, body) => notifications.push({ title, body }),
    });

    engine.start();

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(engine.getStatus(), SnipingState.COMPLETED);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Inline 訂位完成');
    assert.ok(notifications[0].body.includes('完成預約'));
    assert.ok(adapter._getState().submittedReservation);
  });
});
