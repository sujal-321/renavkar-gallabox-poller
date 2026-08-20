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
  getSystemPrompt
} = require('./ai_agent');

test('getSystemPrompt includes current IST timestamp', () => {
  const prompt = getSystemPrompt();
  assert.ok(prompt.includes('CURRENT SYSTEM TIME (ASIA/KOLKATA - IST)'));
  assert.ok(prompt.includes('IST'));
  assert.ok(prompt.includes('STRICT LEAD QUALIFICATION PROTOCOL'));
});

test('parseTime handles various time representations', () => {
  assert.deepEqual(parseTime('5pm'), { hours: 17, minutes: 0 });
  assert.deepEqual(parseTime('5 PM'), { hours: 17, minutes: 0 });
  assert.deepEqual(parseTime('5:30 pm'), { hours: 17, minutes: 30 });
  assert.deepEqual(parseTime('11 am'), { hours: 11, minutes: 0 });
  assert.deepEqual(parseTime('12 pm'), { hours: 12, minutes: 0 });
  assert.deepEqual(parseTime('12 am'), { hours: 0, minutes: 0 });
  assert.deepEqual(parseTime('4'), { hours: 16, minutes: 0 }); // 4 -> 4 PM default
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

  // TBD / N/A returns empty
  assert.equal(normalizeVisitDateTime('TBD', baseDate), '');
  assert.equal(normalizeVisitDateTime('N/A', baseDate), '');
  assert.equal(normalizeVisitDateTime('Not specified', baseDate), '');
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
