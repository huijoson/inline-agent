# Inline Booking Assistant

Domain terms and concepts for automating restaurant table reservations on the inline platform.

## Language

**Reservation**:
A confirmed booking arrangement for dining at a specific restaurant, date, time slot, and party size.
_Avoid_: Order, ticket, table

**Booking Target**:
The unique inline reservation URL identifying a specific restaurant and branch.
_Avoid_: Link, page, shop

**Party Size**:
The total number of dining guests, categorized into adult and child counts.
_Avoid_: Guests, seats, head count

**Time Slot**:
A discrete reservation arrival time offered by the restaurant on a given date.
_Avoid_: Timing, schedule, period

**Priority Slot List**:
An ordered sequence of preferred time slots attempted sequentially during reservation.
_Avoid_: Time list, choices

**House Rules**:
Mandatory terms, restrictions, or policies presented in an initial pop-up modal that must be acknowledged before booking.
_Avoid_: Notice, terms modal, popup

**Opening Sniping**:
The automated action of synchronizing with a restaurant's scheduled release moment to claim newly released time slots.
_Avoid_: Rush, fast booking, drop-in

**Cancellation Sniping**:
Continuous periodic polling to claim a previously unavailable time slot that becomes free due to a customer cancellation.
_Avoid_: Polling, waiting, leak-picking

**Deposit Policy**:
A financial guarantee required by certain restaurants to secure a reservation, usually captured via credit card authorization.
_Avoid_: Fee, payment, guarantee money

**Submission Policy**:
The operational rule determining whether the reservation form is submitted autonomously or held for manual confirmation.
_Avoid_: Submit mode, auto-click rule

**Table Category**:
The distinct seating arrangement classification configured by the restaurant (e.g., 一般, 板前吧台, 包廂, 戶外桌).
_Avoid_: Desk, room, seat type

**Seating Preference**:
The prioritized preference list of table categories specified for automated selection, defaulting to the first available category.
_Avoid_: Table order, chair choice
