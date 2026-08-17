const https = require('https');
const { appendLeadToGoogleSheet } = require('./sheets_logger');
const { sendDiscordAlert } = require('./discord_alerter');
const { fetchSupabaseHistory, saveSupabaseMessage, getLocalHistory, addToLocalHistory } = require('./supabase_memory');

const SYSTEM_PROMPT = `You are an AI Real Estate Advisor representing RENAVKAR, an independent realty consulting firm in Ahmedabad established in mid-2010. Renavkar helps customers BUY, SELL, RENT, LEASE, and INVEST across Residential and Commercial property. In this bot, the current campaign focus is the Avestia Stay investment project.

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

## 📥 LEAD QUALIFICATION PROTOCOL
When an investor provides their name, requirement, budget, or requests a site visit, answer warmly and ALWAYS append this hidden XML tag at the VERY END of your message:
<lead_data>{"lead_name":"[Name]","budget":"[Budget]","requirement":"[Studio/1BHK]","preferred_payment_plan":"[Plan]","site_visit_interest":"[Yes/No]","preferred_visit_date":"[Date/Time]"}</lead_data>

Do NOT output this tag unless qualifying lead details. Assure the investor that Owner Arihant Bhura (+91 97149 91000) will follow up.

## VOICE NOTES AND BUTTONS
- If the message begins with [Voice Note Transcribed], answer the transcribed question normally.
- If voice_note_status is failed or the message says the voice note could not be transcribed, apologize briefly and ask the customer to send text or call Arihant.
- If the customer clicks schedule_call or says they want a call/site visit, ask for their preferred date and time and qualify the lead.
- If the customer clicks not_interested, acknowledge the choice politely, do not sell further, and do not ask for more lead details.`;

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
  // Keep last 12 messages in memory
  while (history.length > 12) {
    history.shift();
  }
}

function callOpenAI(messages, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.2
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
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
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
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
      const hasData = Boolean(
        parsedLead.lead_name ||
        parsedLead.budget ||
        parsedLead.requirement ||
        parsedLead.preferred_visit_date ||
        (parsedLead.site_visit_interest && String(parsedLead.site_visit_interest).toLowerCase() === 'yes')
      );

      if (hasData) {
        const webhookUrl = config.googleSheetWebhookUrl || process.env.GOOGLE_SHEET_WEBHOOK_URL;
        if (webhookUrl) {
          console.log(`📝 [Google Sheets] Logging qualified lead: ${parsedLead.lead_name || senderName} (+${phone})...`);
          appendLeadToGoogleSheet(webhookUrl, {
            lead_name: parsedLead.lead_name || senderName,
            phone: phone,
            budget: parsedLead.budget || 'N/A',
            requirement: parsedLead.requirement || 'Studio / 1BHK',
            preferred_payment_plan: parsedLead.preferred_payment_plan || 'Not specified',
            site_visit_interest: parsedLead.site_visit_interest || 'Yes',
            preferred_visit_date: parsedLead.preferred_visit_date || 'TBD'
          }).then(() => {
            console.log(`✅ [Google Sheets] Lead successfully logged for ${parsedLead.lead_name || senderName}`);
          }).catch(err => {
            console.error(`⚠️ [Google Sheets] Failed to log lead: ${err.message}`);
          });
        }
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
  callOpenAI,
  sendGallaboxWhatsApp,
  handleDirectAiMessage,
  getHistory,
  addToHistory
};
