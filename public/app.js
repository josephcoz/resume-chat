// Resume-chat client. Vanilla JS, no framework. Sends conversation history
// to /api/chat, renders SSE stream as a typing bot message.

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
