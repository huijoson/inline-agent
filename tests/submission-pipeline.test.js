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
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify engine halted
    assert.equal(engine.getStatus(), SnipingState.IDLE);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Inline 搶位提醒');
    assert.ok(notifications[0].body.includes('信用卡預授權'));
  });

  it('autonomously submits reservation when free and autoSubmitFree is true', async () => {
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
        autoSubmitFree: true,
      }),
      logger: (msg) => logs.push(msg),
      onNotify: (title, body) => notifications.push({ title, body }),
    });

    engine.start();

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(engine.getStatus(), SnipingState.IDLE);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Inline 訂位完成');
    assert.ok(notifications[0].body.includes('完成預約'));

    // Check adapter recorded submission with guest details
    const submitted = adapter._getState().submittedReservation;
    assert.ok(submitted);
    assert.equal(submitted.guestDetails.name, '李小華');
    assert.equal(submitted.guestDetails.phone, '0988776655');
  });

  it('holds submission for manual confirmation when autoSubmitFree is false', async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(engine.getStatus(), SnipingState.IDLE);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Inline 搶位成功');
    assert.ok(notifications[0].body.includes('請點擊頁面送出'));
    assert.equal(adapter._getState().submittedReservation, null);
  });
});
