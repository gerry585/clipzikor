/* ClipZikor — общие действия над своими клипами.
 * Подключается на странице галереи и на странице клипа.
 *
 *   ClipActions.edit(clip, onSaved)    — окно «Изменить название и игру»
 *   ClipActions.remove(clip, onDeleted) — окно подтверждения удаления
 *
 * clip = { id, title, game }
 */
(function () {
  const escapeHtml = (v) =>
    String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));

  function toast(message, type) {
    if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
  }

  async function api(method, url, body) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      let data = {};
      try { data = await res.json(); } catch (e) { /* пустой ответ */ }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'Сетевая ошибка' } };
    }
  }

  let gamesCache = null;
  async function loadGames() {
    if (gamesCache) return gamesCache;
    const r = await api('GET', '/api/games');
    gamesCache = (r.ok && Array.isArray(r.data.games)) ? r.data.games : ['Другое'];
    return gamesCache;
  }

  function openModal(innerHtml) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[60] bg-dark-950/85 backdrop-blur-md flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true"
        class="w-full max-w-md bg-dark-900 border border-white/10 rounded-3xl p-6 shadow-2xl space-y-4 text-left">
        ${innerHtml}
      </div>`;
    document.body.appendChild(overlay);

    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    return { overlay, close, $: (sel) => overlay.querySelector(sel) };
  }

  const btnCancel = 'px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-sm font-medium text-gray-200 transition';

  // ---------------------------------------------------------
  // Изменить название и игру
  // ---------------------------------------------------------
  async function edit(clip, onSaved) {
    const games = (await loadGames()).slice();
    const current = clip.game || 'Другое';
    if (!games.includes(current)) games.push(current);

    const modal = openModal(`
      <div>
        <h3 class="text-lg font-bold text-white">Изменить клип</h3>
        <p class="text-xs text-gray-400 mt-1">Можно поменять название и категорию игры.</p>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-300 uppercase tracking-wider mb-1.5">Название</label>
        <input id="caTitle" type="text" maxlength="100" value="${escapeHtml(clip.title)}"
          class="glass-input w-full px-4 py-3 rounded-xl text-white text-sm focus:outline-none" />
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-300 uppercase tracking-wider mb-1.5">Игра</label>
        <select id="caGame"
          class="glass-input w-full px-4 py-3 rounded-xl text-white text-sm focus:outline-none cursor-pointer">
          ${games.map((g) => `<option value="${escapeHtml(g)}" class="bg-dark-900 text-white" ${g === current ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('')}
        </select>
      </div>
      <p id="caError" class="hidden text-xs text-rose-400"></p>
      <div class="flex justify-end gap-2 pt-1">
        <button id="caCancel" type="button" class="${btnCancel}">Отмена</button>
        <button id="caSave" type="button"
          class="px-5 py-2 rounded-xl bg-blurple hover:bg-blurple-hover text-white text-sm font-semibold transition disabled:opacity-60">Сохранить</button>
      </div>
    `);

    const titleInput = modal.$('#caTitle');
    const gameSelect = modal.$('#caGame');
    const errorBox = modal.$('#caError');
    const saveBtn = modal.$('#caSave');
    titleInput.focus();
    titleInput.select();

    const showError = (msg) => { errorBox.textContent = msg; errorBox.classList.remove('hidden'); };

    async function save() {
      const title = titleInput.value.trim();
      if (!title) { showError('Название не может быть пустым'); return; }
      const game = gameSelect.value;
      if (title === clip.title && game === current) { modal.close(); return; }

      saveBtn.disabled = true;
      const r = await api('PATCH', `/api/clips/${encodeURIComponent(clip.id)}`, { title, game });
      saveBtn.disabled = false;

      if (!r.ok) { showError(r.data.error || 'Не удалось сохранить изменения'); return; }
      toast('Изменения сохранены', 'success');
      modal.close();
      if (onSaved) onSaved({ title: r.data.title, game: r.data.game });
    }

    modal.$('#caCancel').addEventListener('click', modal.close);
    saveBtn.addEventListener('click', save);
    titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }

  // ---------------------------------------------------------
  // Удалить клип
  // ---------------------------------------------------------
  function remove(clip, onDeleted) {
    const modal = openModal(`
      <div>
        <h3 class="text-lg font-bold text-white">Удалить клип?</h3>
        <p class="text-sm text-gray-300 mt-2 break-words">«${escapeHtml(clip.title)}»</p>
        <p class="text-xs text-gray-400 mt-2">Видео, превью и все комментарии будут удалены безвозвратно.</p>
      </div>
      <p id="caError" class="hidden text-xs text-rose-400"></p>
      <div class="flex justify-end gap-2 pt-1">
        <button id="caCancel" type="button" class="${btnCancel}">Отмена</button>
        <button id="caDelete" type="button"
          class="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold transition disabled:opacity-60">Удалить</button>
      </div>
    `);

    const delBtn = modal.$('#caDelete');
    const errorBox = modal.$('#caError');
    modal.$('#caCancel').focus();

    modal.$('#caCancel').addEventListener('click', modal.close);
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      const r = await api('DELETE', `/api/clips/${encodeURIComponent(clip.id)}`);
      if (!r.ok) {
        delBtn.disabled = false;
        errorBox.textContent = r.data.error || 'Не удалось удалить клип';
        errorBox.classList.remove('hidden');
        return;
      }
      toast('Клип удалён', 'success');
      modal.close();
      if (onDeleted) onDeleted();
    });
  }

  window.ClipActions = { edit, remove, escapeHtml };
})();
