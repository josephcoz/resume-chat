// Resume-chat client. Vanilla JS, no framework. Sends conversation history
// to /api/chat, renders SSE stream as a typing bot message.

// ---------------------------------------------------------------- markdown
// The model answers in markdown, so rendering it as plain text showed raw
// asterisks and hashes. A CDN library is not an option — the page runs under a
// strict CSP with no external hosts — so this is a small self-contained
// renderer covering exactly what the model emits.
//
// Safety: escape ALL html first, then apply markdown to the escaped text. No
// author-supplied markup can survive that order, so innerHTML is safe here.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
}

function renderMarkdown(src) {
  const lines = escapeHtml(src).split('\n');
  const out = [];
  let list = null;      // 'ul' | 'ol' | null
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + renderInline(para.join(' ')) + '</p>'); para = []; }
  };
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { flushPara(); closeList(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara(); closeList();
      const level = Math.min(heading[1].length + 2, 6);   // #->h3, keep h1/h2 for the page
      out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push('<li>' + renderInline(bullet[1]) + '</li>');
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push('<li>' + renderInline(numbered[1]) + '</li>');
      continue;
    }

    closeList();
    para.push(line.trim());
  }
  flushPara(); closeList();
  return out.join('');
}


(() => {
  const messagesEl = document.getElementById('messages');
  const formEl = document.getElementById('composer');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const suggestionsEl = document.getElementById('suggestions');

  const history = []; // [{role: 'user'|'assistant', content: string}]
  let inFlight = false;

  function autoSize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }
  inputEl.addEventListener('input', autoSize);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });

  function addMessage(role, text, opts = {}) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (opts.streaming) div.classList.add('streaming');
    div.textContent = text;
    messagesEl.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return div;
  }

  async function sendMessage(text) {
    if (inFlight || !text.trim()) return;
    inFlight = true;
    sendEl.disabled = true;
    suggestionsEl.style.display = 'none';

    history.push({ role: 'user', content: text });
    addMessage('user', text);
    inputEl.value = '';
    autoSize();

    const botEl = addMessage('bot', '', { streaming: true });
    let acc = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by "\n\n".
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const evt of events) {
          const line = evt.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const piece = typeof obj?.response === 'string' ? obj.response : '';
            if (piece) {
              acc += piece;
              // Plain text while streaming — half-written markdown renders as
              // garbage — then rendered once in full below.
              botEl.textContent = acc;
              botEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
          } catch {
            /* ignore non-JSON */
          }
        }
      }

      botEl.classList.remove('streaming');
      if (acc.trim()) {
        botEl.innerHTML = renderMarkdown(acc);
        botEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
        history.push({ role: 'assistant', content: acc });
      } else {
        botEl.textContent =
          "Hmm, I didn't get a response. Mind trying again?";
      }
    } catch (err) {
      botEl.classList.remove('streaming');
      botEl.textContent =
        `Sorry — something went wrong on my end. (${err.message || 'unknown error'}) ` +
        "You can email Joe directly at josephcoz@gmail.com.";
    } finally {
      inFlight = false;
      sendEl.disabled = false;
      inputEl.focus();
    }
  }

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(inputEl.value);
  });

  suggestionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.suggestion');
    if (!btn) return;
    sendMessage(btn.dataset.q || btn.textContent);
  });
})();
