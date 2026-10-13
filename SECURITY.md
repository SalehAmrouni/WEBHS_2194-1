# Security

## Design

- **Secrets**: the Anthropic API key is read from the server environment only. `.env` files are git-ignored.
- **Transport & headers**: Helmet sets a strict Content Security Policy (`default-src 'self'`, no inline script or style, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`, and HSTS in production. A `Permissions-Policy` disables camera, microphone, geolocation, payment, and USB.
- **Input validation**: every API body is validated with Zod (strict schemas, length limits). JSON bodies are capped at 64 KB.
- **Abuse protection**: per-IP rate limits on chat (12/min), submissions (5/hour), and reads; a global daily cap on AI requests; a honeypot field on the submission form; POSTs from other origins are rejected.
- **Output safety**: the browser builds all dynamic UI with `textContent`/`createElement`. AI responses go through a Markdown renderer that never parses HTML and only allows `http(s)` links and `opp:` references to known ids.
- **AI guardrails**: Zeus's tools are read-only. The system prompt restricts recommendations to database entries, keeps responses appropriate for minors, discourages sharing personal identifiers, and points to the 988 Suicide & Crisis Lifeline when needed. Refusal fallbacks are enabled on supported models.
- **Privacy**: no accounts, cookies, analytics, or third-party scripts. Student profiles stay in the browser; chat transcripts are not stored on the server.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue.
