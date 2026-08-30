/**
 * ReservationTarget Seam Contract & In-Memory Fake Test Harness
 * 
 * Domain Glossary (CONTEXT.md):
 * - Reservation
 * - Booking Target
 * - Party Size
 * - Time Slot
 * - Priority Slot List
 * - House Rules
 * - Opening Sniping
 * - Cancellation Sniping
 * - Deposit Policy
 * - Submission Policy
 */

/**
 * Creates an in-memory fake reservation adapter satisfying the ReservationTarget seam.
 * @param {Object} [options]
 * @param {boolean} [options.houseRulesActive=false]
 * @param {{ adults: number, kids: number }} [options.partySize={ adults: 2, kids: 0 }]
 * @param {string[]} [options.availableDates=[]]
 * @param {string[]} [options.availableSlots=[]]
 * @param {boolean} [options.requiresDeposit=false]
 * @param {number} [options.submissionDelayMs=0]
 */
function createFakeReservationAdapter(options = {}) {
  const state = {
    houseRulesActive: options.houseRulesActive ?? false,
    houseRulesAcknowledgedCount: 0,
    partySize: { ...(options.partySize || { adults: 2, kids: 0 }) },
    selectedDate: options.selectedDate || null,
    availableDates: new Set(options.availableDates || []),
    availableTableTypes: [...(options.availableTableTypes || [])],
    selectedTableType: null,
    availableSlots: [...(options.availableSlots || [])],
    claimedSlot: null,
    requiresDeposit: options.requiresDeposit ?? false,
    isContactFormPage: options.isContactFormPage ?? false,
    submittedReservation: null,
    submissionDelayMs: options.submissionDelayMs || 0,
    callLog: [],
  };

  return {
    // Inspection methods for test verification
    _getState: () => ({ ...state }),
    _getCallLog: () => [...state.callLog],
    _setAvailableSlots: (slots) => {
      state.availableSlots = [...slots];
    },
    _setAvailableTableTypes: (types) => {
      state.availableTableTypes = [...types];
    },
    _setHouseRulesActive: (active) => {
      state.houseRulesActive = active;
    },

    // 1. Acknowledge House Rules
    acknowledgeHouseRules() {
      state.callLog.push({ method: 'acknowledgeHouseRules', timestamp: Date.now() });
      if (state.houseRulesActive) {
        state.houseRulesActive = false;
        state.houseRulesAcknowledgedCount++;
        return true;
      }
      return false;
    },

    // 2. Set Party Size
    setPartySize(adults, kids) {
      state.callLog.push({ method: 'setPartySize', args: { adults, kids }, timestamp: Date.now() });
      state.partySize = { adults: Number(adults), kids: Number(kids) };
    },

    // 3. Select Target Date
    selectDate(targetDate) {
      state.callLog.push({ method: 'selectDate', args: { targetDate }, timestamp: Date.now() });
      if (state.availableDates.size === 0 || state.availableDates.has(targetDate)) {
        state.selectedDate = targetDate;
        return true;
      }
      return false;
    },

    // 3.1 Select Table Type
    selectTableType(preferredTypes = []) {
      state.callLog.push({ method: 'selectTableType', args: { preferredTypes }, timestamp: Date.now() });
      if (state.availableTableTypes.length === 0) {
        return null;
      }
      const prefs = Array.isArray(preferredTypes)
        ? preferredTypes.map((s) => s.trim()).filter(Boolean)
        : String(preferredTypes || '').split(',').map((s) => s.trim()).filter(Boolean);

      if (prefs.length > 0) {
        const normalize = (s) => String(s || '').toLowerCase().replace(/檯/g, '台').replace(/[（）()、，,\s_-]/g, '');
        const coreKeywords = ['板前', '吧台', '一般', '包廂', '戶外', '靠窗', '沙發', '高腳', '方桌', '圓桌'];

        for (const pref of prefs) {
          const normPref = normalize(pref);
          if (!normPref) continue;
          const match = state.availableTableTypes.find((t) => {
            const normT = normalize(t);
            if (normT.includes(normPref) || normPref.includes(normT)) return true;
            return coreKeywords.some((kw) => normPref.includes(kw) && normT.includes(kw));
          });
          if (match) {
            state.selectedTableType = match;
            return match;
          }
        }
      }
      // Default: select first available
      state.selectedTableType = state.availableTableTypes[0];
      return state.selectedTableType;
    },

    // 4. Claim Time Slot by Priority List
    claimSlot(priorityList) {
      state.callLog.push({ method: 'claimSlot', args: { priorityList }, timestamp: Date.now() });
      for (const pref of priorityList) {
        const trimmed = pref.trim();
        const match = state.availableSlots.find((s) => s.includes(trimmed));
        if (match) {
          state.claimedSlot = match;
          return match;
        }
      }
      return null;
    },

    // 4.1 Advance to Contact Form
    clickSlotContinueButton() {
      state.callLog.push({ method: 'clickSlotContinueButton', timestamp: Date.now() });
      return true;
    },

    // 4.2 Check Contact Form Page
    isContactFormPage() {
      state.callLog.push({ method: 'isContactFormPage', timestamp: Date.now() });
      return !!state.isContactFormPage;
    },

    // 5. Submit Reservation
    async submitReservation(guestDetails, policy = { autoSubmit: true }) {
      state.callLog.push({ method: 'submitReservation', args: { guestDetails, policy }, timestamp: Date.now() });
      
      if (state.submissionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.submissionDelayMs));
      }

      if (state.requiresDeposit) {
        return {
          success: false,
          status: 'DEPOSIT_REQUIRED',
          message: 'Deposit Policy active: manual credit card confirmation required',
        };
      }

      if (!policy.autoSubmit) {
        return {
          success: false,
          status: 'HELD_FOR_MANUAL_SUBMISSION',
          message: 'Submission Policy set to manual confirmation',
        };
      }

      state.submittedReservation = {
        guestDetails: { ...guestDetails },
        claimedSlot: state.claimedSlot,
        date: state.selectedDate,
        partySize: { ...state.partySize },
        timestamp: Date.now(),
      };

      return {
        success: true,
        status: 'CONFIRMED',
        reservation: state.submittedReservation,
      };
    },
  };
}

module.exports = {
  createFakeReservationAdapter,
};
