# FlowState AI Standard: Headless AI Agent Microservices

## 1. When to Use Standalone Code vs. n8n
- **Use Standalone Microservice Daemon**:
  - Real-time WhatsApp/Telegram/SMS chatbots (<1s latency).
  - High-frequency polling loops (1-5s intervals).
  - Voice agent dispatchers (VAPI integrations).
  - Production client systems requiring 99.99% uptime with <25MB RAM.
- **Use n8n**:
  - Scheduled batch jobs (daily scraping, CRM reconciliation).
  - Multi-app SaaS triggers (Stripe -> Slack -> Notion).

## 2. Invariant Engineering Principles
1. **Multi-Bubble Debouncing**: Never reply to individual rapid-fire messages independently. Buffer for 5 seconds per contact.
2. **Keyed Serialization**: Always process queue items for the same phone sequentially to prevent race conditions.
3. **Atomic State Storage**: Persist processed message IDs to disk/memory to prevent duplicate dispatches on restarts.
4. **Clean Restarts**: Keep `seedAgeMs` tight (e.g. 2 minutes) on startup so historical backlogs do not re-trigger.
5. **Google Apps Script Bridge**: Follow 302 redirects via `GET` for zero-overhead Google Sheets 2-way sync.
