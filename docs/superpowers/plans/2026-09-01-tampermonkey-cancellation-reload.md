# Tampermonkey Cancellation Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cancellation Sniping survive real page reloads under Tampermonkey so a disabled Booking Date can be rediscovered when it becomes bookable.

**Architecture:** A small localStorage-backed runtime-state store records whether Cancellation Sniping is active for the exact Booking Target. `SnipingEngine` keeps reload policy behind the `ReservationTarget` seam and reports lifecycle changes through a callback; the browser bootstrap resumes only a matching persisted cancellation run after Tampermonkey reinjects the userscript. Opening Sniping remains an in-page flow and never auto-resumes after reload.

**Tech Stack:** Tampermonkey userscript metadata, browser JavaScript, localStorage, Node.js native test runner (`node:test`), no new dependencies.

## Global Constraints

- Real page reload is used only by Cancellation Sniping after a failed date or Time Slot check.
- Persisted resume state is scoped to the exact origin, path, and query string of the Booking Target.
- Manual stop, confirmed submission, deposit handoff, and manual-submission fallback all clear persisted resume state.
- Opening Sniping never persists an auto-resume state.
- `SnipingEngine` must not directly access `window`, `document`, `localStorage`, or `location`; reload stays behind `ReservationTarget.reloadPage()`.
- `inline-reservation-bot.user.js` and `inline-sniper.js` remain byte-identical.
- Tampermonkey metadata uses a higher `@version` and raw GitHub update/download URLs.
- Keep `package.json` dependency-free and preserve `node --test`.
- Existing uncommitted `CONTEXT.md`, ADR 0002, and the opening-window plan must be preserved.

---

## File Map

- `inline-reservation-bot.user.js`: canonical metadata, runtime-state store, DOM adapter reload seam, engine lifecycle, and reload-resume bootstrap.
- `inline-sniper.js`: byte-identical compatibility mirror of the canonical userscript.
- `tests/runtime-state.test.js`: persistence, target scoping, and malformed-storage behavior.
- `tests/sniping-engine.test.js`: cancellation reload and lifecycle callback behavior.
- `tests/reservation-target-seam.js`: in-memory reload seam used by engine tests.
- `tests/integration-smoke.test.js`: Tampermonkey metadata and canonical/mirror parity.
- `README.md`, `USER_GUIDE.md`: Tampermonkey installation, cancellation reload, auto-resume, and stop semantics.
- `package.json`: feature version bump.

---

### Task 1: Persist and scope Cancellation Sniping resume state

**Files:**
- Create: `tests/runtime-state.test.js`
- Modify: `inline-reservation-bot.user.js:19-70,1483-1490`

**Interfaces:**
- Produces: `createRuntimeStateStore(storage, key?)`
- Produces: `store.activate(bookingTarget): void`
- Produces: `store.deactivate(): void`
- Produces: `store.shouldResume(bookingTarget): boolean`
- Produces: `store.load(): { active: boolean, mode: string | null, bookingTarget: string }`

- [ ] **Step 1: Write the failing runtime-state tests**

```js
const { createRuntimeStateStore } = require('../inline-reservation-bot.user.js');

it('resumes an active cancellation run only on the exact Booking Target', () => {
  const storage = createMemoryStorage();
  const store = createRuntimeStateStore(storage);

  store.activate('https://inline.app/booking/shop-a?language=zh-tw');

  assert.equal(store.shouldResume('https://inline.app/booking/shop-a?language=zh-tw'), true);
  assert.equal(store.shouldResume('https://inline.app/booking/shop-b?language=zh-tw'), false);
});

it('does not resume after explicit deactivation', () => {
  const store = createRuntimeStateStore(createMemoryStorage());
  store.activate('https://inline.app/booking/shop-a');
  store.deactivate();
  assert.equal(store.shouldResume('https://inline.app/booking/shop-a'), false);
});

it('treats malformed persisted state as inactive', () => {
  const storage = createMemoryStorage({ INLINE_SNIPER_RUNTIME_V1: '{broken' });
  const store = createRuntimeStateStore(storage);
  assert.deepEqual(store.load(), { active: false, mode: null, bookingTarget: '' });
});
```

These tests catch missing target scoping, failure to clear a stopped run, and unsafe JSON parsing.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/runtime-state.test.js`

Expected: FAIL because `createRuntimeStateStore` is not exported.

- [ ] **Step 3: Implement the minimal runtime-state store**

```js
const RUNTIME_STORAGE_KEY = 'INLINE_SNIPER_RUNTIME_V1';
const INACTIVE_RUNTIME_STATE = Object.freeze({ active: false, mode: null, bookingTarget: '' });

function createRuntimeStateStore(storage, key = RUNTIME_STORAGE_KEY) {
  function load() {
    try {
      const parsed = JSON.parse(storage?.getItem(key) || 'null');
      if (!parsed || parsed.active !== true || parsed.mode !== 'cancellation' || !parsed.bookingTarget) {
        return { ...INACTIVE_RUNTIME_STATE };
      }
      return { active: true, mode: 'cancellation', bookingTarget: String(parsed.bookingTarget) };
    } catch {
      return { ...INACTIVE_RUNTIME_STATE };
    }
  }

  return {
    load,
    activate(bookingTarget) {
      storage?.setItem(key, JSON.stringify({ active: true, mode: 'cancellation', bookingTarget }));
    },
    deactivate() {
      storage?.removeItem(key);
    },
    shouldResume(bookingTarget) {
      const saved = load();
      return saved.active && saved.bookingTarget === bookingTarget;
    },
  };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/runtime-state.test.js`

Expected: all runtime-state tests PASS.

---

### Task 2: Reload through the seam and clear persistence at terminal states

**Files:**
- Modify: `tests/reservation-target-seam.js:30-145`
- Modify: `tests/sniping-engine.test.js:60-174`
- Modify: `inline-reservation-bot.user.js:595-1170,1187-1427`

**Interfaces:**
- Consumes: `ReservationTarget.reloadPage(): boolean`
- Produces: `createSnipingEngine({ onRunStateChange })`
- Produces: `onRunStateChange({ active, mode }): void`

- [ ] **Step 1: Write failing cancellation reload and lifecycle tests**

```js
it('reloads the page after a cancellation check finds no Time Slot', async () => {
  const adapter = createFakeReservationAdapter({ availableSlots: [] });
  const engine = createSnipingEngine({
    adapter,
    getConfig: () => ({
      mode: 'cancellation', pollIntervalMin: 5, pollIntervalMax: 5,
      targetDate: '2026-11-01', adults: '4', kids: '0', prioritySlots: '18:00',
    }),
    logger: () => {},
    onStatusUpdate: () => {},
  });

  engine.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(adapter._getState().reloadCount, 1);
});

it('publishes inactive lifecycle state when the operator stops', () => {
  const lifecycle = [];
  const engine = createSnipingEngine({
    adapter: createFakeReservationAdapter(),
    getConfig: () => ({ mode: 'cancellation', targetDate: '2026-11-01', prioritySlots: '18:00' }),
    onRunStateChange: (event) => lifecycle.push(event),
    logger: () => {},
    onStatusUpdate: () => {},
  });

  engine.start();
  engine.stop();

  assert.deepEqual(lifecycle.at(-1), { active: false, mode: 'cancellation' });
});
```

These tests catch a return to DOM-only retries and stale auto-resume state after Stop.

- [ ] **Step 2: Run the engine suite and verify RED**

Run: `node --test tests/sniping-engine.test.js`

Expected: FAIL because the fake and real adapters do not expose `reloadPage()` and the engine has no lifecycle callback.

- [ ] **Step 3: Implement reload and lifecycle seams**

Add `reloadPage()` to the real adapter, using an injected `reload` function in tests and `window.location.reload()` in the browser. Add reload counting to the fake adapter. Replace Cancellation Sniping's soft re-selection timeout body with one `adapter.reloadPage()` call. Publish active state from `start()` and inactive state from `stop()` plus every terminal submission branch.

```js
const onRunStateChange = deps.onRunStateChange || (() => {});

function scheduleNextPoll() {
  const cfg = configProvider();
  const interval = Math.floor(Math.random() * (cfg.pollIntervalMax - cfg.pollIntervalMin + 1) + cfg.pollIntervalMin);
  logger(`⏳ 目前無空位，將於 ${(interval / 1000).toFixed(1)} 秒後重新整理頁面查詢...`);
  pollTimeoutId = setTimeout(() => adapter.reloadPage(), interval);
}
```

- [ ] **Step 4: Run engine and integration suites and verify GREEN**

Run: `node --test tests/sniping-engine.test.js tests/integration-smoke.test.js`

Expected: cancellation reload and lifecycle tests PASS; the engine still contains no direct browser globals.

---

### Task 3: Auto-resume after Tampermonkey reinjection and publish an installable release

**Files:**
- Modify: `inline-reservation-bot.user.js:1-11,1429-1481`
- Modify: `tests/integration-smoke.test.js:1-50`
- Modify: `README.md`
- Modify: `USER_GUIDE.md`
- Modify: `package.json`
- Modify: `inline-sniper.js`

**Interfaces:**
- Consumes: Task 1 runtime store and Task 2 lifecycle callback.
- Produces: guarded browser bootstrap that starts only an active matching Cancellation Sniping run.
- Produces: install/update URL `https://raw.githubusercontent.com/huijoson/inline-agent/main/inline-reservation-bot.user.js`.

- [ ] **Step 1: Write the failing metadata and parity test**

```js
it('publishes Tampermonkey update metadata and keeps both distributed scripts identical', () => {
  assert.ok(fileContent.includes('// @version      2.2.0'));
  assert.ok(fileContent.includes('// @updateURL    https://raw.githubusercontent.com/huijoson/inline-agent/main/inline-reservation-bot.user.js'));
  assert.ok(fileContent.includes('// @downloadURL  https://raw.githubusercontent.com/huijoson/inline-agent/main/inline-reservation-bot.user.js'));
  assert.equal(fileContent, fs.readFileSync(path.resolve(__dirname, '../inline-sniper.js'), 'utf8'));
});
```

This test catches a release that Tampermonkey cannot update or whose two advertised entry files diverge.

- [ ] **Step 2: Run the integration test and verify RED**

Run: `node --test tests/integration-smoke.test.js`

Expected: FAIL because metadata is still version 1.0.0 and has no update/download URLs.

- [ ] **Step 3: Implement guarded resume and release metadata**

Instantiate the runtime store from `localStorage`. Build the Booking Target key from `location.origin + location.pathname + location.search`. Wire the singleton engine lifecycle callback to activate only Cancellation Sniping and deactivate every other state. During `init()`, attempt resume once after the body exists:

```js
let resumeAttempted = false;
function resumePersistedCancellation() {
  if (resumeAttempted || !document.body) return;
  resumeAttempted = true;
  const bookingTarget = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  if (config.mode === 'cancellation' && runtimeStateStore.shouldResume(bookingTarget)) {
    addLog('♻️ 已從 Tampermonkey 自動恢復釋出撿漏');
    SnipingEngine.start();
  }
}
```

Set userscript and package version to `2.2.0`, add official update/download metadata, document installation and Stop behavior, then mechanically copy the canonical userscript to `inline-sniper.js`.

- [ ] **Step 4: Run full verification**

Run: `npm test && git diff --check && cmp -s inline-reservation-bot.user.js inline-sniper.js`

Expected: all tests PASS, no whitespace errors, and distributed scripts are byte-identical.
