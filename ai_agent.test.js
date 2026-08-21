'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatToISTStandard,
  parseTime,
  normalizeVisitDateTime,
  isQualifiedLead,
  isLeadDuplicate,
  recordLoggedLead,
  clearLoggedLeadsCache,
  getSystemPrompt,
  parseLeadAction,
  executeLeadAction
} = require('./ai_agent');
const { fetchLeadState, clearLeadStateCache } = require('./supabase_memory');

test('getSystemPrompt includes current IST timestamp', () => {
  const prompt = getSystemPrompt();
  assert.ok(prompt.includes('CURRENT SYSTEM TIME (ASIA/KOLKATA - IST)'));
  assert.ok(prompt.includes('IST'));
  assert.ok(prompt.includes('STRICT LEAD QUALIFICATION PROTOCOL'));
});

test('getSystemPrompt grounds appointment answers in verified lead state', () => {
  const prompt = getSystemPrompt({
    lead_name: 'Sujal Darla',
    requirement: '1BHK',
    budget: '75 Lakhs',
    preferred_visit_date: '21/08/2026, 05:00 PM',
    status: 'CONFIRMED'
  }, new Date('2026-08-21T04:15:00.000Z'));

  assert.match(prompt, /VERIFIED CUSTOMER STATE/);
  assert.match(prompt, /Sujal Darla/);
  assert.match(prompt, /21\/08\/2026, 05:00 PM/);
  assert.match(prompt, /APPOINTMENT VERIFICATION & RELATIVE DATE RULES/);
  assert.match(prompt, /today/i);
});

test('getSystemPrompt flags the IST midnight ambiguity window', () => {
  const prompt = getSystemPrompt(null, new Date('2026-08-20T22:00:00.000Z'));
  assert.match(prompt, /NIGHT_HOURS_ACTIVE: true/);
  assert.match(prompt, /12:00 AM.*5:00 AM/i);
});

test('parseTime handles various time representations', () => {
  assert.deepEqual(parseTime('5pm'), { hours: 17, minutes: 0 });
  assert.deepEqual(parseTime('5 PM'), { hours: 17, minutes: 0 });
  assert.deepEqual(parseTime('5:30 pm'), { hours: 17, minutes: 30 });
  assert.deepEqual(parseTime('11 am'), { hours: 11, minutes: 0 });
  assert.deepEqual(parseTime('12 pm'), { hours: 12, minutes: 0 });
  assert.deepEqual(parseTime('12 am'), { hours: 0, minutes: 0 });
  assert.deepEqual(parseTime('4'), { hours: 16, minutes: 0 }); // 4 -> 4 PM default
  assert.deepEqual(parseTime('morning'), { hours: 11, minutes: 0 });
  assert.deepEqual(parseTime('afternoon'), { hours: 15, minutes: 0 });
  assert.deepEqual(parseTime('after lunch'), { hours: 15, minutes: 0 });
  assert.deepEqual(parseTime('sham ko'), { hours: 17, minutes: 0 });
});

test('normalizeVisitDateTime converts relative dates correctly', () => {
  // Use a fixed Thursday date in 2026: 20 August 2026
  const baseDate = new Date('2026-08-20T12:00:00+05:30');

  // "Tomorrow at 5 PM" -> 21/08/2026, 05:00 PM
  const tomorrowRes = normalizeVisitDateTime('Tomorrow at 5 PM', baseDate);
  assert.equal(tomorrowRes, '21/08/2026, 05:00 PM');

  // "Tommorow um like 5 pm?" -> 21/08/2026, 05:00 PM
  const tommorowTypo = normalizeVisitDateTime('Tommorow um like 5 pm?', baseDate);
  assert.equal(tommorowTypo, '21/08/2026, 05:00 PM');

  // "Today at 4 PM" -> 20/08/2026, 04:00 PM
  const todayRes = normalizeVisitDateTime('Today at 4 PM', baseDate);
  assert.equal(todayRes, '20/08/2026, 04:00 PM');

  // "Day after tomorrow at 11 AM" -> 22/08/2026, 11:00 AM
  const dayAfter = normalizeVisitDateTime('Day after tomorrow at 11 AM', baseDate);
  assert.equal(dayAfter, '22/08/2026, 11:00 AM');

  // "Saturday 4 PM" from Thursday -> 22/08/2026, 04:00 PM
  const satRes = normalizeVisitDateTime('Saturday 4 PM', baseDate);
  assert.equal(satRes, '22/08/2026, 04:00 PM');

  // Existing standard format DD/MM/YYYY, hh:mm AM/PM is preserved
  const standard = normalizeVisitDateTime('21/08/2026, 05:00 PM', baseDate);
  assert.equal(standard, '21/08/2026, 05:00 PM');

  assert.equal(normalizeVisitDateTime('Saturday after lunch', baseDate), '22/08/2026, 03:00 PM');
  assert.equal(normalizeVisitDateTime('tomorrow evening', baseDate), '21/08/2026, 05:00 PM');

  // TBD / N/A returns empty
  assert.equal(normalizeVisitDateTime('TBD', baseDate), '');
  assert.equal(normalizeVisitDateTime('N/A', baseDate), '');
  assert.equal(normalizeVisitDateTime('Not specified', baseDate), '');
});

test('parseLeadAction extracts lifecycle and requirement update tags', () => {
  const reschedule = parseLeadAction(
    'Done <lead_action type="RESCHEDULE">{"new_visit_date":"23/08/2026, 11:00 AM"}</lead_action>'
  );
  assert.equal(reschedule.type, 'RESCHEDULE');
  assert.equal(reschedule.action, 'RESCHEDULE');
  assert.equal(reschedule.data.new_visit_date, '23/08/2026, 11:00 AM');

  const cancel = parseLeadAction(
    '<lead_action type="CANCEL">{"reason":"User requested cancellation"}</lead_action>'
  );
  assert.equal(cancel.type, 'CANCEL');
  assert.equal(cancel.data.reason, 'User requested cancellation');

  const legacy = parseLeadAction(
    '<lead_data>{"requirement":"Studio","budget":"38.16 Lakhs","site_visit_interest":"Yes","preferred_visit_date":"21/08/2026, 05:00 PM"}</lead_data>'
  );
  assert.equal(legacy.type, 'CREATE');
  assert.equal(legacy.data.requirement, 'Studio');

  const pivot = parseLeadAction(
    '<lead_action type="UPDATE_REQUIREMENT">{"requirement":"1BHK","budget":"74.88 Lakhs"}</lead_action>'
  );
  assert.equal(pivot.type, 'UPDATE_REQUIREMENT');
  assert.equal(pivot.data.budget, '74.88 Lakhs');
});

test('executeLeadAction persists appointment lifecycle changes before external sync', async () => {
  clearLeadStateCache();
  await executeLeadAction('919014998200', {
    type: 'RESCHEDULE',
    data: { new_visit_date: '23/08/2026, 11:00 AM' }
  }, {});

  const state = await fetchLeadState('919014998200');
  assert.equal(state.preferred_visit_date, '23/08/2026, 11:00 AM');
  assert.equal(state.status, 'RESCHEDULED');
});

test('isQualifiedLead enforces strict qualification', () => {
  // Fully qualified lead
  const validLead = {
    lead_name: 'Sujal Darla',
    requirement: '1BHK',
    budget: '1 crore',
    site_visit_interest: 'Yes',
    preferred_visit_date: '21/08/2026, 05:00 PM'
  };
  assert.equal(isQualifiedLead(validLead), true);

  // Missing visit interest (No)
  const noInterest = {
    lead_name: 'Arihant',
    requirement: 'shop',
    budget: '1 cr',
    site_visit_interest: 'No',
    preferred_visit_date: 'TBD'
  };
  assert.equal(isQualifiedLead(noInterest), false);

  // Missing date (TBD)
  const tbdDate = {
    lead_name: 'Arihant',
    requirement: 'Studio',
    site_visit_interest: 'Yes',
    preferred_visit_date: 'TBD'
  };
  assert.equal(isQualifiedLead(tbdDate), false);

  // Missing requirement AND budget
  const noReqOrBudget = {
    lead_name: 'Anonymous',
    requirement: 'Not specified',
    budget: 'N/A',
    site_visit_interest: 'Yes',
    preferred_visit_date: '21/08/2026, 05:00 PM'
  };
  assert.equal(isQualifiedLead(noReqOrBudget), false);
});

test('isLeadDuplicate correctly flags duplicate leads and allows updates', () => {
  clearLoggedLeadsCache();
  const phone = '9014998200';
  const lead1 = {
    requirement: '1BHK',
    budget: '1 crore',
    preferred_visit_date: '21/08/2026, 05:00 PM'
  };

  assert.equal(isLeadDuplicate(phone, lead1), false);
  recordLoggedLead(phone, lead1);

  // Second identical check within window -> DUPLICATE
  assert.equal(isLeadDuplicate(phone, lead1), true);

  // Another lead with same date and details -> DUPLICATE
  const duplicateLead = {
    requirement: '1BHK',
    budget: '1 crore',
    preferred_visit_date: '21/08/2026, 05:00 PM'
  };
  assert.equal(isLeadDuplicate(phone, duplicateLead), true);
});
