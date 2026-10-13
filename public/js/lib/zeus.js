// Zeus chat widget: streams answers from /api/chat (Server-Sent Events over
// fetch), renders them as safe Markdown, and turns opportunity references
// into buttons that open the detail dialog.

import { h, icon, refreshIcons, clear, toast } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { getChat, saveChat, clearChat, profileForAI, getProfile } from './store.js';

const MAX_SEND = 20;

let healthPromise = null;
export function checkAiHealth() {
  healthPromise ??= fetch('/api/health').then((r) => r.json()).then((j) => !!j.ai).catch(() => false);
  return healthPromise;
}

function suggestionsFor(profile) {
  const s = [];
  if (profile?.interests?.length) {
    s.push(`What are the best ${profile.interests[0] === 'Scholarships' ? 'scholarships' : 'opportunities'} for me right now?`);
  } else {
    s.push('Help me figure out what kinds of opportunities fit me.');
  }
  s.push(profile?.financialNeed ? 'Which free or paid summer programs should I look at?' : 'What summer programs are worth applying to?');
  s.push(profile?.grade ? `Make me a plan for the rest of ${profile.grade}th grade.` : 'What should I be doing each year of high school?');
  s.push('How do I ask a teacher for a recommendation letter?');
  return s;
}

/**
 * @param {HTMLElement} root  container element (gets the full chat UI)
 * @param {{ knownIds?: Set<string>, onOpenOpportunity?: (id: string) => void, title?: string }} options
 */
export function mountZeus(root, options = {}) {
  const ctx = { knownIds: options.knownIds };
  let history = getChat();
  let controller = null;
  let online = null;

  const statusDot = h('span', { class: 'status-dot' });
  const statusText = h('span', { text: 'Connecting…' });
  const messages = h('div', { class: 'zeus-messages', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Conversation with Zeus' });
  const textarea = h('textarea', { rows: '1', placeholder: 'Ask Zeus anything…', 'aria-label': 'Message Zeus', maxlength: '4000' });
  const sendBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-icon', 'aria-label': 'Send message' }, icon('arrow-up'));
  const stopBtn = h('button', { type: 'button', class: 'btn btn-outline btn-icon', 'aria-label': 'Stop generating', hidden: true }, icon('square'));
  const newChatBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Start a new chat', title: 'New chat' }, icon('rotate-ccw'));

  const form = h('form', {}, textarea, stopBtn, sendBtn);
  root.classList.add('zeus-dock');
  root.replaceChildren(
    h('div', { class: 'zeus-head' },
      h('div', { class: 'zeus-avatar' }, icon('sparkles')),
      h('div', {},
        h('div', { class: 'title', text: options.title ?? 'Zeus, your AI counselor' }),
        h('div', { class: 'subtitle' }, statusDot, statusText)),
      h('div', { class: 'actions' }, newChatBtn, options.closeButton ?? null)),
    messages,
    h('div', { class: 'zeus-input' },
      form,
      h('div', { class: 'zeus-disclaimer', text: 'Zeus is AI and can make mistakes. Verify details on official sites.' })));

  // ---- rendering --------------------------------------------------------------
  const scrollToEnd = () => { messages.scrollTop = messages.scrollHeight; };

  function welcome() {
    const profile = getProfile();
    const name = profile?.firstName ? `, ${profile.firstName}` : '';
    return h('div', { class: 'zeus-welcome' },
      h('h3', { text: `Hi${name}! I'm Zeus.` }),
      h('p', { class: 'small mb-0', text: 'I can search hundreds of programs, internships, competitions, and scholarships, and help you build a plan. What are you curious about?' }),
      online === false ? null : h('div', { class: 'suggestions' },
        suggestionsFor(profile).map((text) => h('button', { type: 'button', class: 'suggestion', onclick: () => ask(text) }, text))));
  }

  function bubble(role, content) {
    if (role === 'user') return h('div', { class: 'bubble user', text: content });
    const el = h('div', { class: 'bubble assistant' });
    el.append(renderMarkdown(content, ctx));
    return el;
  }

  function renderAll() {
    clear(messages);
    if (!history.length) messages.append(welcome());
    for (const m of history) messages.append(bubble(m.role, m.content));
    if (online === false) messages.append(offlineNotice());
    refreshIcons();
    scrollToEnd();
  }

  function offlineNotice() {
    return h('div', { class: 'bubble notice' }, 'Zeus is offline right now (the server has no AI key configured). You can still browse and filter every opportunity.');
  }

  function setBusy(busy) {
    sendBtn.hidden = busy;
    stopBtn.hidden = !busy;
    textarea.disabled = busy || online === false;
    newChatBtn.disabled = busy;
  }

  function setOnline(value) {
    online = value;
    statusDot.className = `status-dot ${value ? 'online' : 'offline'}`;
    statusText.textContent = value ? 'Online · powered by Claude' : 'Offline';
    textarea.disabled = !value;
    sendBtn.disabled = !value;
    renderAll();
  }

  // ---- networking ---------------------------------------------------------------
  function payloadMessages() {
    let msgs = history.slice(-MAX_SEND);
    while (msgs.length && msgs[0].role !== 'user') msgs = msgs.slice(1);
    return msgs.map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  }

  async function ask(text) {
    const content = text.trim();
    if (!content || controller || online === false) return;
    messages.querySelector('.zeus-welcome')?.remove();

    history.push({ role: 'user', content });
    messages.append(bubble('user', content));

    const reply = h('div', { class: 'bubble assistant' }, h('span', { class: 'typing', 'aria-label': 'Zeus is thinking' }, h('span'), h('span'), h('span')));
    const status = h('div', { class: 'zeus-status', hidden: true });
    messages.append(reply, status);
    scrollToEnd();

    controller = new AbortController();
    setBusy(true);
    let acc = '';
    let frame = 0;
    const paint = () => {
      frame = 0;
      reply.replaceChildren(renderMarkdown(acc, ctx));
      scrollToEnd();
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ messages: payloadMessages(), profile: profileForAI() }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Zeus is unavailable (${res.status}).`);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let streamError = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.type === 'text') {
            acc += event.text;
            if (!frame) frame = requestAnimationFrame(paint);
          } else if (event.type === 'status') {
            status.hidden = !event.text;
            status.replaceChildren(icon('loader-2', 'spin'), event.text ? `${event.text}…` : '');
            refreshIcons();
          } else if (event.type === 'error') {
            streamError = event.message;
          }
        }
      }
      if (frame) cancelAnimationFrame(frame);
      paint();
      status.remove();
      if (streamError && !acc.trim()) throw new Error(streamError);
      if (streamError) messages.append(h('div', { class: 'bubble error' }, icon('alert-circle'), h('span', { text: streamError })));
      history.push({ role: 'assistant', content: acc.trim() || '(No response)' });
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      status.remove();
      if (err.name === 'AbortError') {
        if (acc.trim()) {
          paint();
          history.push({ role: 'assistant', content: `${acc.trim()}\n\n_(stopped)_` });
        } else {
          reply.remove();
          history.pop();
        }
      } else {
        reply.remove();
        history.pop(); // keep history valid (it must end on an assistant turn)
        const retry = h('button', { type: 'button', class: 'btn btn-sm btn-outline', onclick: () => { errorEl.remove(); ask(content); } }, 'Try again');
        const errorEl = h('div', { class: 'bubble error' }, icon('alert-circle'), h('div', {}, h('div', { text: err.message || 'Something went wrong.' }), h('div', { class: 'mt-1' }, retry)));
        messages.append(errorEl);
      }
    } finally {
      controller = null;
      saveChat(history);
      setBusy(false);
      refreshIcons();
      scrollToEnd();
      textarea.focus();
    }
  }

  // ---- events ---------------------------------------------------------------------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = textarea.value;
    textarea.value = '';
    autosize();
    ask(text);
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const autosize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  };
  textarea.addEventListener('input', autosize);
  stopBtn.addEventListener('click', () => controller?.abort());
  newChatBtn.addEventListener('click', () => {
    history = [];
    clearChat();
    renderAll();
    toast('Started a new chat');
  });
  messages.addEventListener('click', (e) => {
    const link = e.target.closest('.opp-link');
    if (link) options.onOpenOpportunity?.(link.dataset.oppId);
  });

  renderAll();
  checkAiHealth().then(setOnline);

  return {
    ask,
    focus: () => textarea.focus(),
    prefill(text) {
      textarea.value = text;
      autosize();
      textarea.focus();
    },
  };
}
