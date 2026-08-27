# Separate DOM Automation and Sniping Orchestration via Deep ReservationTarget Seam

## Context

The inline reservation automation script combines volatile DOM element querying, Radix UI attribute parsing, React prototype property descriptor overrides, high-frequency timer scheduling, and UI state updates in a monolithic script. Any frontend style or markup revision on inline.app risks breaking the entire automation suite and prevents automated offline testing without a live browser.

## Decision

We decided to encapsulate all inline.app DOM interactions and React state overrides behind a deep `ReservationTarget` seam implemented as an internal `InlineDomAdapter` object, keeping the userscript in a single, zero-build `.user.js` file (DEC-03). The `SnipingEngine` interacts strictly through high-level domain operations:

- `acknowledgeHouseRules(): boolean`
- `setPartySize(adults: number, kids: number): void`
- `selectDate(targetDate: string): boolean`
- `claimSlot(priorityList: string[]): TimeSlot | null`
- `submitReservation(guestDetails: GuestDetails, policy: SubmissionPolicy): Promise<SubmitResult>`

The `SnipingEngine` is tested against an in-memory `FakeReservationAdapter` to verify all timing, fallback, and retry invariants without a real browser.

## Consequences

- **Positive**: Isolates DOM fragility to a single adapter; changes to inline markup do not affect the core sniping state machine.
- **Positive**: Enables fast offline contract testing against fake adapters without running browser instances or waiting for live midnight drops.
- **Positive**: Maintains zero-build, single-file copy-paste installation for Tampermonkey users.
- **Tradeoff**: Internal contracts must be maintained with strict discipline without a TypeScript compiler toolchain.
