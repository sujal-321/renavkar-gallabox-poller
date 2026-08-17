const https = require('https');
const http = require('http');

function sendDiscordAlert({ webhookUrl, title, description, error, phone, level = 'info' }) {
  return new Promise((resolve) => {
    const url = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
    if (!url) return resolve({ skipped: true, reason: 'No Discord webhook URL' });

    let color = 5763719; // Green (info)
    if (level === 'warn') color = 16776960; // Yellow
    if (level === 'error') color = 15548997; // Red

    const fields = [];
    if (phone) fields.push({ name: 'Phone', value: `+${phone}`, inline: true });
    if (level) fields.push({ name: 'Level', value: level.toUpperCase(), inline: true });
    if (error) fields.push({ name: 'Error Details', value: `\`\`\`${String(error).slice(0, 1000)}\`\`\``, inline: false });

    const payload = JSON.stringify({
      username: 'FlowState Alert Bot',
      embeds: [{
        title: title || 'FlowState Bot Notification',
        description: description || '',
        color: color,
        fields,
        footer: { text: 'FlowState AI Agency • Renavkar Real Estate Bot' },
        timestamp: new Date().toISOString()
      }]
    });

    try {
      const u = new URL(url);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.request({
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, res => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });

      req.on('error', err => {
        console.error(`Discord alert network error: ${err.message}`);
        resolve({ ok: false, error: err.message });
      });

      req.write(payload);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

module.exports = { sendDiscordAlert };
