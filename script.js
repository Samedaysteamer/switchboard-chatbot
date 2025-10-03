// script.js — chat front-end with enforced typing delay (5–10s),
// sticky composer on mobile, quick replies, and resilient fallback.

(function () {
  // ---- DOM ----
  const chatBox = document.getElementById('chat-box');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('user-input');
  const sendBtn = document.getElementById('send-btn') || (form ? form.querySelector('button[type="submit"]') : null);

  if (!chatBox || !form || !input) {
    console.error('Chat DOM not found: #chat-box, #chat-form, #user-input');
    return;
  }

  // ---- State ----
  let state = {};
  let busy = false;
  let started = false;
  let typingEl = null;
  let pendingPrompt = null; // last prompt we should re-ask after FAQ answers

  // Typing delay window (random 5–10s). To lock to a fixed delay, set both to same ms.
  const TYPING_MIN_MS = 1000;
  const TYPING_MAX_MS = 4000;

  // ---- Helpers ----
  const scrollToEnd = () => chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: 'smooth' });

  function setBusy(v) {
    busy = !!v;
    if (sendBtn) {
      sendBtn.disabled = busy;
      sendBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    input.disabled = !!busy; // avoid double-submits from keyboard
  }

  function addMsg(text, who = 'bot') {
    if (!text) return;
    const el = document.createElement('div');
    el.className = `msg ${who}`;
    el.innerHTML = String(text)
      .replace(/\n/g, '<br>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    chatBox.appendChild(el);
    scrollToEnd();
    return el;
  }

  function showTyping(show) {
    if (show) {
      if (typingEl) return;
      typingEl = document.createElement('div');
      typingEl.className = 'msg bot typing'; // <-- 'typing' class so CSS can style/position it
      typingEl.innerHTML = `
        <span class="typing-dots" aria-live="polite" aria-label="Typing">
          <i></i><i></i><i></i>
        </span>`;
      chatBox.appendChild(typingEl);
      scrollToEnd();
    } else if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  function clearQuickReplies() {
    chatBox.querySelectorAll('.quick-replies').forEach((n) => n.remove());
  }

  function addQuickReplies(labels = []) {
    if (!labels.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'quick-replies chips';
    wrap.style.margin = '8px 0 2px';

    labels.forEach((label) => {
      const b = document.createElement('button');
      b.type = 'button'; // do NOT submit form
      b.className = 'chip';
      b.textContent = label;
      b.addEventListener('click', async () => {
        if (busy) return;
        addMsg(label, 'user');
        clearQuickReplies();
        await send(label);
      });
      wrap.appendChild(b);
    });

    chatBox.appendChild(wrap);
    scrollToEnd();
  }

  function isQuestion(t = '') {
    const s = String(t).trim();
    if (!s) return false;
    return /\?$/.test(s) ||
      /^(what|when|how|who|where|why|do|does|can|is|are|should|could|would|am i|are y)\b/i.test(s);
  }

  async function post(body) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function send(text) {
    if (busy) return;
    setBusy(true);
    try {
      clearQuickReplies();
      showTyping(true);

      // Prepare request
      const req = isQuestion(text)
        ? post({ intent: 'faq', question: text, pendingPrompt, state })
        : post({ message: text, state });

      // Keep dots visible >= min delay (even if server is instant)
      const waitMs = Math.floor(TYPING_MIN_MS + Math.random() * (TYPING_MAX_MS - TYPING_MIN_MS));
      const [data] = await Promise.all([req, new Promise(r => setTimeout(r, waitMs))]);

      showTyping(false);

      if (data.reply) addMsg(data.reply, 'bot');
      if (data.quickReplies) addQuickReplies(data.quickReplies);
      if (data.state) state = data.state;

      // After an FAQ answer, re-ask the pending booking question to keep flow going
      if (data.intentHandled === 'faq' && pendingPrompt) {
        addMsg(pendingPrompt, 'bot');
      }

      if (data.isPrompt) {
        pendingPrompt = data.reply;
      }
    } catch (e) {
      console.error(e);
      showTyping(false);
      addMsg('Sorry — connection hiccup. Please try again.', 'bot');
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  }

  async function init() {
    if (started) return;
    started = true;
    try {
      showTyping(true);
      const data = await post({ init: true, state });
      showTyping(false);

      if (data.reply) {
        addMsg(data.reply, 'bot');
        pendingPrompt = data.reply;
      }
      if (data.quickReplies) addQuickReplies(data.quickReplies);
      if (data.state) state = data.state;
    } catch (e) {
      // Fallback opener to avoid blank UI
      console.error(e);
      showTyping(false);
      const opener = 'Are you looking for carpet cleaning, upholstery cleaning, or air duct cleaning service?';
      addMsg(opener, 'bot');
      pendingPrompt = opener;
      addQuickReplies(['Carpet Cleaning', 'Upholstery Cleaning', 'Air Duct Cleaning']);
    }
  }

  // ---- Events ----
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = (input.value || '').trim();
    if (!text || busy) return;
    addMsg(text, 'user');
    input.value = '';
    send(text);
  });

  // Keep composer visible on iOS/Android when keyboard opens
  input.addEventListener('focus', () => {
    setTimeout(scrollToEnd, 100);
    setTimeout(scrollToEnd, 400);
  });
  window.addEventListener('resize', () => setTimeout(scrollToEnd, 150));

  // ---- Boot ----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();