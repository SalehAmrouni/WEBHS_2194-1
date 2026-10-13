# Student Atlas

**An AI-guided map of opportunities for high school students.**

Student Atlas helps students find research programs, internships, competitions, summer programs, scholarships, service, and leadership opportunities that fit them, especially students who don't have easy access to a college counselor. A short Pathway Wizard builds a private profile, every opportunity gets an explainable fit score, and **Zeus**, an AI counselor powered by Claude, searches the directory and helps students plan their next steps.

## Features

- **200+ curated opportunities** across seven areas: STEM, Health & Medicine, Business, Arts & Media, Civics & Leadership, Service & Environment, and Scholarships & College Access. Each one links to its official site and lists grades, cost, format, and typical deadline.
- **Zeus AI counselor.** A real large language model (Claude, via the official Anthropic SDK) that streams answers and uses read-only tools to search the database. It recommends only real entries, which render as clickable cards in the chat.
- **Pathway Wizard + explainable matching.** Students see a fit score for each opportunity with the reasons behind it ("Open to 10th graders", "Pays participants") and eligibility warnings.
- **Explore view** with search, filters (interest, type, grade, cost, format, affordable, deadline soon, eligible, saved), sorting, and shareable URLs.
- **My Pathway** dashboard: fit by interest area, top matches, saved list, upcoming deadlines, plus data export and deletion.
- **Community submissions**, validated on the server and queued for human review.
- **Accessibility**: text sizing, light/dark/auto theme, high contrast, readable font, color-blind friendly palette (Okabe-Ito), reduced motion, read-aloud, keyboard navigation, and screen-reader labels.

## Security & privacy

- No accounts or passwords. The profile, saved list, and settings live in the student's browser.
- The Anthropic API key stays on the server and is never sent to the browser.
- A strict Content Security Policy (no inline scripts or styles, no third-party origins) and security headers via Helmet.
- All input validated with Zod; request size limits; same-origin checks on POST; per-IP rate limits and a daily cap on AI requests.
- AI output is rendered with a safe Markdown renderer that never uses `innerHTML` and only allows `http(s)` links.
- Chat transcripts are not stored on the server.

See [SECURITY.md](SECURITY.md) for details.

## Getting started

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env      # then add your ANTHROPIC_API_KEY
npm run dev               # http://localhost:3000
```

Without an API key the site still works; Zeus shows as offline.

| Command | What it does |
| --- | --- |
| `npm start` | Start the server (reads environment variables) |
| `npm run dev` | Start with auto-reload and `.env` loading |
| `npm test` | Run the test suite |
| `npm run validate-data` | Validate every opportunity against the schema |

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (none) | Enables Zeus. Create one at console.anthropic.com. |
| `ZEUS_MODEL` | `claude-opus-5-5` | Claude model used by Zeus |
| `ZEUS_EFFORT` | `medium` | Reasoning effort (`low`, `medium`, `high`) |
| `ZEUS_DAILY_LIMIT` | `2000` | Max chat requests per day (cost protection) |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | (none) | Set to `production` to enable HSTS and caching |
| `TRUST_PROXY` | (none) | Set (e.g. `1`) when behind a reverse proxy so rate limits see real IPs |

## Deploying

Student Atlas needs a Node.js host (it is no longer a static site, because the server keeps the AI key secret). Render, Railway, and Fly.io all work. On Render, for example:

1. Create a new **Web Service** from this GitHub repository.
2. Build command: `npm install`. Start command: `npm start`.
3. Add environment variables: `ANTHROPIC_API_KEY`, `NODE_ENV=production`, and `TRUST_PROXY=1` (the host puts a proxy in front of the app; this lets rate limits see each visitor's real IP).

Community suggestions are written to `data/submissions/`. On hosts with temporary disks, attach a persistent disk there (or set `SUBMISSIONS_DIR`) so they aren't lost on redeploy.

## Project structure

```
server/            Express app, AI counselor, submissions, data loader
data/opportunities One JSON file per interest area (the database)
public/            Static site: HTML pages, CSS, and ES-module JavaScript
  js/lib/          Shared modules (store, matching, chat, wizard, markdown, UI)
  js/pages/        One module per page
scripts/           Data validation
tests/             node:test suite
```

### Adding an opportunity

Add an entry to the right file in `data/opportunities/` and run `npm run validate-data`. The schema lives in `server/opportunities.js`. Community suggestions arrive in `data/submissions/queue.jsonl` (not committed) for review.

## Credits

Built with Node.js, Express, Helmet, express-rate-limit, Zod, the Anthropic SDK, and Lucide icons. Opportunity details are summarized from each organization's official website; always confirm current dates and eligibility there.
