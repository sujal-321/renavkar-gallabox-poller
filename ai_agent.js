const https = require('https');
const { appendLeadToGoogleSheet } = require('./sheets_logger');
const { sendDiscordAlert } = require('./discord_alerter');
const { fetchSupabaseHistory, saveSupabaseMessage, getLocalHistory, addToLocalHistory } = require('./supabase_memory');

function getSystemPrompt() {
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const formattedNow = nowIST.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  return `You are an AI Real Estate Advisor representing RENAVKAR, an independent realty consulting firm in Ahmedabad established in mid-2010. Renavkar helps customers BUY, SELL, RENT, LEASE, and INVEST across Residential and Commercial property. In this bot, the current campaign focus is the Avestia Stay investment project.

## 🕒 CURRENT SYSTEM TIME (ASIA/KOLKATA - IST)
Current Date & Time: ${formattedNow} (IST).
Use this real-time clock to resolve relative dates. When an investor mentions "tomorrow 5pm", "this Saturday 4pm", "next Monday", convert it to the exact calendar date format: DD/MM/YYYY, hh:mm A (e.g. 21/08/2026, 05:00 PM).

## 🚫 CRITICAL RULES & BOUNDARIES
1. **INTERMEDIARY / CHANNEL PARTNER ONLY**: Renavkar Real Estate is an independent intermediary, broker, and channel partner — NOT the builder or developer. Do not present Renavkar as the project owner, developer, seller, or operator.
2. **STRICT NO-HALLUCINATION**: You must ONLY answer questions using the factual knowledge base provided below. Do NOT guess, invent, or make up ANY details (prices, dates, areas, legal terms, or other cities). If a question is outside your knowledge base, respond politely:
   "I'll connect you with our team for accurate details on that. You can reach Arihant Bhura (Owner, Renavkar Real Estate) directly at +91 97149 91000."
3. **DEFAULT LANGUAGE IS ENGLISH**: Always start and converse in crisp, professional, warm **ENGLISH** by default (including when the lead clicks 'Interested' or 'Interested?' or gives English responses).
4. **SWITCH TO HINDI/HINGLISH ONLY IF CUSTOMER INITIATES IN HINDI/HINGLISH**: Do NOT use Hindi or Hinglish unless the customer explicitly sends a message in Hindi or Hinglish (e.g., "batao", "price kitna hai", "kaha hai project"). If they do, respond in warm Hinglish (Roman script).
5. **NO AVESTIA IN FIRST GREETING**: Do NOT mention the project name "Avestia Stay" in your initial greeting or opening message. First ask the investor what they are looking for (e.g. budget, Studio or 1BHK, ROI expectations).
6. **WHEN TO INTRODUCE AVESTIA STAY**: Introduce Avestia Stay details ONLY AFTER the investor specifies what they are looking for or asks about available projects/commercial options.
7. **BROCHURE / PDF PROTOCOL**: When an investor asks for a brochure, PDF, layout, or catalog, answer warmly and include this link:
   "You can view & download the official Avestia Stay e-brochure here 📄: https://drive.google.com/uc?export=download&id=1ilA69U8h50An9e4g4q880zKI-2-Rfkf4"
8. **OWNER CONTACT**: For direct calls, escalations, or owner consultation: Arihant Bhura (Owner at Renavkar Real Estate) — +91 97149 91000.
9. **COMPANY SCOPE**: If asked what Renavkar does, explain that it covers Ahmedabad residential and commercial property transactions and advisory, including buying, selling, renting, leasing, investment services, property management, landlord/tenant representation, bank-finance assistance, and project/turn-key assistance. Do not claim that every listed property is available or that Renavkar controls the seller's terms.
10. **LISTING / LEGAL DISCLAIMER**: Property prices, rents, availability, and project terms are supplied by the relevant builder/owner and must be confirmed with the Renavkar team. Renavkar facilitates introductions and does not control or mediate disputes between buyer and seller.

## 🗣️ LANGUAGE & TONE RULES
- **DEFAULT**: Always respond in clean, warm, professional English.
  *Example*: "Hello! Thank you for showing interest in Renavkar Real Estate. What type of property are you looking for — Studio Apartments or 1BHK commercial units?"
- **HINDI / HINGLISH**: Switch to Hinglish ONLY if the customer initiates or sends a message in Hindi/Hinglish first.
- Use clear bullet points, bold key figures, emojis (✨, 📍, 🏢, 💰, 📅, 📞). Keep WhatsApp messages concise.

## 🏢 KNOWLEDGE BASE: AVESTIA STAY (PRAHLAD NAGAR, AHMEDABAD)
- **Project**: Avestia Stay (Pre-Leased Commercial Co-Living / Studio Asset)
- **Developer**: Avestia
- **Channel Partner / Broker**: Renavkar Real Estate
- **Location**: Corporate Road, Prahlad Nagar, Ahmedabad. Maps: https://maps.app.goo.gl/jGEUj6qarF8Y9vKr9
- **Pricing & Rent**:
  1. Studio (530 sq ft SBU): ₹38.16 Lakhs | Rent: ₹28,620/month
  2. 1 BHK (1040 sq ft SBU): ₹74.88 Lakhs | Rent: ₹56,160/month
- **Returns**: 9% Assured ROI (Avg 9.93%). 9-Yr Lease, 4-Yr Lock-in. 10% rent escalation every 3 years. Zero vacancy risk, Zero maintenance, Zero property tax for investor.
- **Payment Plans**:
  - Down Payment: Booking ₹2L → Plan Pass ₹4L → Post RERA balance in 15 days (Rent starts immediately!)
  - Upfront Discount: Booking ₹2L → Plan Pass ₹4L → Balance post RERA after discount (Rent starts 1 Jan 2028)
  - Regular: Booking ₹2L → Plan Pass ₹4L → 30% Post RERA → 15 EMIs (Rent starts on possession)
- **Brochure PDF**: https://drive.google.com/uc?export=download&id=1ilA69U8h50An9e4g4q880zKI-2-Rfkf4
- **Renavkar office**: A-503 Safal Pegasus, 100 Ft Prahlad Nagar Road, opposite Shell Petrol Pump, Satellite, Ahmedabad 380015. Office: 079-40064848. Email: arihant@re-navkar.com.

## 📥 STRICT LEAD QUALIFICATION PROTOCOL
You must ONLY qualify a lead and append the <lead_data> tag when the customer has provided their details AND explicitly confirmed interest in a site visit or appointment.
Do NOT output <lead_data> for general inquiries, exploratory browsing, or if the user says "No" / is undecided.

When ALL qualification criteria are met (Requirement/Budget known + Site visit explicitly agreed + Visit Date/Time specified):
Append this hidden XML tag at the VERY END of your message:
<lead_data>{"lead_name":"[Name]","budget":"[Budget]","requirement":"[Studio/1BHK]","preferred_payment_plan":"[Plan]","site_visit_interest":"Yes","preferred_visit_date":"DD/MM/YYYY, hh:mm A"}</lead_data>

Do NOT output <lead_data> unless ALL criteria are met and site_visit_interest is "Yes". Assure the investor that Owner Arihant Bhura (+91 97149 91000) will follow up.

## VOICE NOTES AND BUTTONS
- If the message begins with [Voice Note Transcribed], answer the transcribed question normally.
- If voice_note_status is failed or the message says the voice note could not be transcribed, apologize briefly and ask the customer to send text or call Arihant.
- If the customer clicks schedule_call or says they want a call/site visit, ask for their preferred date and time.
- If the customer clicks not_interested, acknowledge the choice politely, do not sell further, and do not ask for more lead details.`;
}

const SYSTEM_PROMPT = getSystemPrompt();

// In-memory qualified lead deduplication cache
const loggedLeadsCache = new Map(); // phone -> { fingerprint, visitDate, timestamp, data }

function formatToISTStandard(d, hours = 11, minutes = 0) {
  const target = new Date(d);
  target.setHours(hours, minutes, 0, 0);
  
  const day = String(target.getDate()).padStart(2, '0');
  const month = String(target.getMonth() + 1).padStart(2, '0');
  const year = target.getFullYear();
  
  let h = target.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  h = h ? h : 12;
  const strHours = String(h).padStart(2, '0');
  const strMinutes = String(target.getMinutes()).padStart(2, '0');
  
  return `${day}/${month}/${year}, ${strHours}:${strMinutes} ${ampm}`;
}

function parseTime(timeStr) {
  if (!timeStr) return { hours: 11, minutes: 0 };
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return { hours: 11, minutes: 0 };
  
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const modifier = match[3] ? match[3].toLowerCase() : null;
  
  if (modifier === 'pm' && hours < 12) hours += 12;
  if (modifier === 'am' && hours === 12) hours = 0;
  if (!modifier && hours >= 1 && hours <= 7) hours += 12;
  
  return { hours, minutes };
}

function normalizeVisitDateTime(dateStr, baseDate = new Date()) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const str = dateStr.trim();
  if (/^tbd$|^n\/?a$|^not\s*specified$|^none$|^null$|^undefined$/i.test(str)) return '';
  
  // Check if it's already in DD/MM/YYYY, hh:mm AM/PM format
  const alreadyFormatted = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:,\s*|\s+)(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))$/i);
  if (alreadyFormatted) {
    const d = String(alreadyFormatted[1]).padStart(2, '0');
    const m = String(alreadyFormatted[2]).padStart(2, '0');
    const y = alreadyFormatted[3];
    const time = alreadyFormatted[4].toUpperCase();
    return `${d}/${m}/${y}, ${time}`;
  }

  // Get current date components in IST
  const now = new Date(baseDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const lower = str.toLowerCase();
  
  const timeInfo = parseTime(str);

  if (lower.includes('today')) {
    return formatToISTStandard(now, timeInfo.hours, timeInfo.minutes);
  }
  
  if (lower.includes('day after tomorrow')) {
    const target = new Date(now);
    target.setDate(target.getDate() + 2);
    return formatToISTStandard(target, timeInfo.hours, timeInfo.minutes);
  }

  if (lower.includes('tomorrow') || lower.includes('tommorow') || lower.includes('tomrw')) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    return formatToISTStandard(target, timeInfo.hours, timeInfo.minutes);
  }

  // Day of week handling
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i])) {
      const currentDay = now.getDay();
      let diff = i - currentDay;
      if (diff <= 0) diff += 7;
      const target = new Date(now);
      target.setDate(target.getDate() + diff);
      return formatToISTStandard(target, timeInfo.hours, timeInfo.minutes);
    }
  }

  // Check if string contains ISO or standard numeric format e.g. "2023-10-04 17:00:00"
  const isoMatch = str.match(/(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  if (isoMatch) {
    let year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    const h = isoMatch[4] ? parseInt(isoMatch[4], 10) : timeInfo.hours;
    const m = isoMatch[5] ? parseInt(isoMatch[5], 10) : timeInfo.minutes;
    
    if (year < now.getFullYear()) {
      year = now.getFullYear();
    }
    const target = new Date(year, month, day, h, m);
    return formatToISTStandard(target, h, m);
  }

  const parsed = Date.parse(str);
  if (!isNaN(parsed)) {
    const parsedDate = new Date(parsed);
    if (parsedDate.getFullYear() < now.getFullYear()) {
      parsedDate.setFullYear(now.getFullYear());
    }
    return formatToISTStandard(parsedDate, parsedDate.getHours() || timeInfo.hours, parsedDate.getMinutes() || timeInfo.minutes);
  }

  return str;
}

function isQualifiedLead(lead) {
  if (!lead || typeof lead !== 'object') return false;

  // 1. Must have explicit confirmation of interest in visit/consultation
  const interest = String(lead.site_visit_interest || '').trim().toLowerCase();
  const hasInterest = interest === 'yes' || interest === 'true' || interest === 'interested' || interest === 'schedule';
  if (!hasInterest) return false;

  // 2. Must have a real preferred visit date & time (not TBD, not N/A, not empty)
  const rawDate = String(lead.preferred_visit_date || '').trim();
  if (!rawDate || /^tbd$|^n\/?a$|^not\s*specified$|^none$|^null$|^undefined$/i.test(rawDate)) {
    return false;
  }

  // 3. Must have requirement or budget provided
  const req = String(lead.requirement || '').trim();
  const budget = String(lead.budget || '').trim();
  const hasRequirement = Boolean(req && !/^not\s*specified$|^n\/?a$|^none$|^undefined$/i.test(req));
  const hasBudget = Boolean(budget && !/^not\s*specified$|^n\/?a$|^none$|^undefined$/i.test(budget));
  if (!hasRequirement && !hasBudget) {
    return false;
  }

  return true;
}

function getLeadFingerprint(phone, leadData) {
  const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);
  const req = String(leadData.requirement || '').trim().toLowerCase();
  const budget = String(leadData.budget || '').trim().toLowerCase();
  const visitDate = String(leadData.preferred_visit_date || '').trim().toLowerCase();
  return `${cleanPhone}_${req}_${budget}_${visitDate}`;
}

function isLeadDuplicate(phone, leadData, windowMs = 24 * 60 * 60 * 1000) {
  const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);
  if (!cleanPhone) return false;

  const fingerprint = getLeadFingerprint(cleanPhone, leadData);
  const existing = loggedLeadsCache.get(cleanPhone);

  if (existing) {
    const isWithinWindow = Date.now() - existing.timestamp < windowMs;
    if (isWithinWindow && (existing.fingerprint === fingerprint || existing.visitDate === String(leadData.preferred_visit_date || '').trim())) {
      return true;
    }
  }

  return false;
}

function recordLoggedLead(phone, leadData) {
  const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);
  if (!cleanPhone) return;

  const fingerprint = getLeadFingerprint(cleanPhone, leadData);
  loggedLeadsCache.set(cleanPhone, {
    fingerprint,
    visitDate: String(leadData.preferred_visit_date || '').trim(),
    timestamp: Date.now(),
    data: leadData
  });
}

function clearLoggedLeadsCache() {
  loggedLeadsCache.clear();
}

const conversationHistory = new Map();

function getHistory(phone) {
  if (!conversationHistory.has(phone)) {
    conversationHistory.set(phone, []);
  }
  return conversationHistory.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content, timestamp: Date.now() });
  while (history.length > 12) {
    history.shift();
  }
}

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30000
});

function callOpenAI(messages, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.1,
      max_tokens: 250
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      agent: keepAliveAgent,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.choices && json.choices[0]) {
            resolve(json.choices[0].message.content);
          } else {
            reject(new Error(`OpenAI API error: ${JSON.stringify(json)}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendGallaboxWhatsApp({ accountId, apiKey, apiSecret, channelId, phone, recipientName, text }) {
  return new Promise((resolve, reject) => {
    const cleanPhone = String(phone).replace(/[^0-9]/g, '');
    const payload = JSON.stringify({
      channelId,
      channelType: 'whatsapp',
      recipient: {
        name: recipientName || 'Valued Investor',
        rawPhone: `+${cleanPhone}`
      },
      whatsapp: {
        type: 'text',
        text: {
          body: text
        }
      }
    });

    const req = https.request({
      hostname: 'server.gallabox.com',
      path: `/devapi/accounts/${accountId}/messages/whatsapp`,
      method: 'POST',
      agent: keepAliveAgent,
      headers: {
        'apiKey': apiKey,
        'apiSecret': apiSecret,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, statusCode: res.statusCode, body });
        } else {
          reject(new Error(`Gallabox HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function handleDirectAiMessage(payload, config) {
  const phone = String(
    payload.sender_phone ||
    payload.phone ||
    payload.contact?.phone ||
    ''
  ).replace(/[^0-9]/g, '');

  const userText = String(
    payload.message_text ||
    payload.message?.text ||
    payload.text ||
    payload.button_payload ||
    payload.button_text ||
    'Hello'
  ).trim();

  const senderName = payload.sender_name || payload.contact?.name || 'Valued Investor';

  if (!userText) {
    throw new Error('Message text is empty');
  }

  const history = await fetchSupabaseHistory(phone, config, 12);
  const currentPrompt = getSystemPrompt();
  const messages = [
    { role: 'system', content: currentPrompt },
    ...history.map(h => ({ role: h.role, content: String(h.content || '') })),
    { role: 'user', content: userText }
  ];

  console.log(`🤖 [Direct AI] Generating reply for ${senderName} (+${phone}): "${userText}"`);

  let rawAiReply;
  try {
    rawAiReply = await callOpenAI(messages, config.openAiKey || process.env.OPENAI_API_KEY);
  } catch (err) {
    sendDiscordAlert({
      webhookUrl: config.discordWebhookUrl,
      title: '🚨 OpenAI API Generation Failed',
      description: `Failed to generate AI reply for **${senderName}** (\`+${phone}\`)`,
      error: err.message,
      phone,
      level: 'error'
    });
    throw err;
  }

  const cleanReply = String(rawAiReply).replace(/<lead_data>[\s\S]*?<\/lead_data>/g, '').trim();

  // Check if lead details were qualified
  const match = String(rawAiReply).match(/<lead_data>(.*?)<\/lead_data>/s);
  if (match && match[1]) {
    try {
      const parsedLead = JSON.parse(match[1]);
      
      // Normalize visit date & time
      if (parsedLead.preferred_visit_date) {
        parsedLead.preferred_visit_date = normalizeVisitDateTime(parsedLead.preferred_visit_date);
      }

      // Check strict qualification criteria
      if (isQualifiedLead(parsedLead)) {
        const leadPayload = {
          lead_name: parsedLead.lead_name || senderName,
          phone: phone,
          budget: parsedLead.budget || 'N/A',
          requirement: parsedLead.requirement || 'Studio / 1BHK',
          preferred_payment_plan: parsedLead.preferred_payment_plan || 'Not specified',
          site_visit_interest: parsedLead.site_visit_interest || 'Yes',
          preferred_visit_date: parsedLead.preferred_visit_date
        };

        // Check for deduplication
        if (!isLeadDuplicate(phone, leadPayload)) {
          recordLoggedLead(phone, leadPayload);
          const webhookUrl = config.googleSheetWebhookUrl || process.env.GOOGLE_SHEET_WEBHOOK_URL;
          if (webhookUrl) {
            console.log(`📝 [Google Sheets] Logging qualified lead: ${leadPayload.lead_name} (+${phone}) with Visit: "${leadPayload.preferred_visit_date}"...`);
            appendLeadToGoogleSheet(webhookUrl, leadPayload).then(() => {
              console.log(`✅ [Google Sheets] Lead successfully logged for ${leadPayload.lead_name}`);
            }).catch(err => {
              console.error(`⚠️ [Google Sheets] Failed to log lead: ${err.message}`);
            });
          }
        } else {
          console.log(`⏭️ [Google Sheets] Skipping duplicate lead recording for ${senderName} (+${phone}) - already logged in this window`);
        }
      } else {
        console.log(`ℹ️ [Direct AI] Lead data emitted but not fully qualified yet (Interest: ${parsedLead.site_visit_interest}, Date: ${parsedLead.preferred_visit_date}) - skipped Google Sheets write`);
      }
    } catch (err) {
      console.error(`Lead tag parse error: ${err.message}`);
    }
  }

  // Save to history (both in-memory and Supabase)
  if (phone) {
    saveSupabaseMessage(phone, 'user', userText, config);
    saveSupabaseMessage(phone, 'assistant', cleanReply, config);
  }

  console.log(`📲 [Direct AI] Sending reply to +${phone}...`);
  try {
    await sendGallaboxWhatsApp({
      accountId: config.accountId || process.env.GALLABOX_ACCOUNT_ID,
      apiKey: config.apiKey || process.env.GALLABOX_API_KEY,
      apiSecret: config.apiSecret || process.env.GALLABOX_API_SECRET,
      channelId: config.channelId || process.env.GALLABOX_CHANNEL_ID,
      phone,
      recipientName: senderName,
      text: cleanReply
    });
  } catch (err) {
    sendDiscordAlert({
      webhookUrl: config.discordWebhookUrl,
      title: '🚨 Gallabox Delivery Failed',
      description: `Failed to deliver WhatsApp message to **${senderName}** (\`+${phone}\`)`,
      error: err.message,
      phone,
      level: 'error'
    });
    throw err;
  }

  console.log(`✅ [Direct AI] Reply delivered successfully to +${phone}`);
  return {
    ok: true,
    message_id: payload.message_id || payload.id || 'direct-msg',
    reply_sent: true,
    reply_text: cleanReply
  };
}

module.exports = {
  SYSTEM_PROMPT,
  getSystemPrompt,
  formatToISTStandard,
  parseTime,
  normalizeVisitDateTime,
  isQualifiedLead,
  isLeadDuplicate,
  recordLoggedLead,
  clearLoggedLeadsCache,
  callOpenAI,
  sendGallaboxWhatsApp,
  handleDirectAiMessage,
  getHistory,
  addToHistory
};

