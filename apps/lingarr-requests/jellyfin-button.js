(() => {
  'use strict';
  const requestPage = 'https://fabjon-hp.tail681ec9.ts.net:3011/';
  const buttonClass = 'lingarrTranslateNowButton';
  let pendingItemId = '';
  let scheduled = false;

  function currentItemId() {
    const hash = window.location.hash || '';
    const queryIndex = hash.indexOf('?');
    if (queryIndex >= 0) {
      const params = new URLSearchParams(hash.slice(queryIndex + 1));
      const itemId = params.get('id') || params.get('itemId');
      if (itemId) return itemId;
    }
    const match = hash.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : '';
  }

  async function updateButton() {
    const itemId = currentItemId();
    const existing = document.querySelector(`.${buttonClass}`);
    if (!itemId) {
      existing?.remove();
      return;
    }
    if (existing?.dataset.itemId === itemId) return;
    existing?.remove();
    if (pendingItemId === itemId) return;

    const api = window.ApiClient;
    if (!api || typeof api.getItem !== 'function' || typeof api.getCurrentUserId !== 'function') return;
    pendingItemId = itemId;
    try {
      const item = await api.getItem(api.getCurrentUserId(), itemId);
      if (!item || !['Movie', 'Episode'].includes(item.Type) || currentItemId() !== itemId) return;

      const container = document.querySelector('.mainDetailButtons');
      if (!container || container.querySelector(`.${buttonClass}`)) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'emby-button raised ' + buttonClass;
      button.dataset.itemId = itemId;
      button.textContent = 'Translate subtitles now';
      button.setAttribute('aria-label', `Open translation request for ${item.Name || 'this item'}`);
      button.addEventListener('click', () => {
        const url = new URL(requestPage);
        url.searchParams.set('itemId', itemId);
        window.open(url.href, '_blank', 'noopener,noreferrer');
      });

      const playButton = container.querySelector('.btnPlay');
      if (playButton) playButton.insertAdjacentElement('afterend', button);
      else container.append(button);
    } catch (_) {
      // Hide the action if Jellyfin cannot confirm the selected item's type.
    } finally {
      if (pendingItemId === itemId) pendingItemId = '';
    }
  }

  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      updateButton();
    }, 120);
  }

  window.addEventListener('hashchange', scheduleUpdate);
  window.addEventListener('popstate', scheduleUpdate);
  new MutationObserver(scheduleUpdate).observe(document.documentElement, { childList: true, subtree: true });
  scheduleUpdate();
})();
