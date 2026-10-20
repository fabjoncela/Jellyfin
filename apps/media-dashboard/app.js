'use strict';

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');
let allRequests = [];
let serviceHealth = [];
let detailedAttentionAlerts = [];
let detailedCheckState = 'idle';
let detailedCheckSummary = null;
let actionUnlocked = false;
let interactiveRequestId = null;
let interactiveReleases = [];
let selectedRelease = null;
const STALE_REQUEST_MS = 48 * 60 * 60 * 1000;

function formatDate(value) {
  if (!value) return 'Current state';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? escapeHtml(value) : date.toLocaleString();
}

function badge(value) {
  const label = escapeHtml(value || 'Unknown');
  const className = label.toLowerCase().replace(/[^a-z]+/g, '-');
  return `<span class="badge ${className}">${label}</span>`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

async function api(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

async function actionApi(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The action could not be completed');
  return body;
}

function renderHealth(health) {
  serviceHealth = health.services;
  const unhealthy = health.services.filter((service) => service.status !== 'healthy');
  $('#health').textContent = unhealthy.length
    ? `${unhealthy.map((service) => service.service).join(', ')} unavailable`
    : 'Seerr, Radarr & Sonarr healthy';
  $('#health').className = `health ${unhealthy.length ? 'warning' : 'healthy'}`;
}

function renderRequests(requests) {
  const root = $('#requests');
  $('#request-count').textContent = requests.length === allRequests.length
    ? `${requests.length} shown`
    : `${requests.length} of ${allRequests.length} shown`;
  if (!requests.length) {
    root.innerHTML = '<p>No requests found.</p>';
    return;
  }
  root.innerHTML = requests.map((request) => `
    <button type="button" class="request" data-request-id="${Number(request.id)}">
      <span class="request-main">
        <strong>${escapeHtml(request.title)}</strong>
        <small>${escapeHtml(request.type)} · Updated ${formatDate(request.updatedAt)}</small>
      </span>
      <span class="request-state">${badge(request.status)}</span>
    </button>
  `).join('');
  root.querySelectorAll('[data-request-id]').forEach((button) => {
    button.addEventListener('click', () => loadDetail(button.dataset.requestId));
  });
}

function attentionItems() {
  const now = Date.now();
  const items = serviceHealth
    .filter((service) => service.status !== 'healthy')
    .map((service) => ({
      level: 'error',
      title: `${service.service} is unavailable`,
      message: `Dashboard health check: ${service.status}.`,
    }));

  if (detailedCheckState === 'unavailable') {
    items.push({
      level: 'warning',
      title: 'Detailed attention check unavailable',
      message: 'The dashboard could not check imported titles or active Arr pipeline issues. Refresh to retry.',
    });
  }

  detailedAttentionAlerts.forEach((request) => {
    items.push({
      level: request.level === 'error' ? 'error' : 'warning',
      title: request.title,
      message: request.message || 'This request needs attention.',
      request,
    });
  });

  allRequests.forEach((request) => {
    if (request.status === 'Failed') {
      items.push({ level: 'error', title: request.title, message: 'Seerr marked this request as failed.', request });
      return;
    }
    if (request.status === 'Declined') {
      items.push({ level: 'warning', title: request.title, message: 'This Seerr request was declined.', request });
      return;
    }
    const updatedAt = Date.parse(request.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt < STALE_REQUEST_MS) return;
    if (request.status === 'Pending approval') {
      items.push({ level: 'warning', title: request.title, message: 'Awaiting Seerr approval with no update for 48+ hours.', request });
    } else if (request.status === 'Approved') {
      items.push({ level: 'warning', title: request.title, message: 'Approved with no Seerr update for 48+ hours.', request });
    }
  });
  return items;
}

function renderAttention() {
  const root = $('#attention');
  const items = attentionItems();
  const detailSuffix = detailedCheckState === 'checking' ? ' · checking details…' : '';
  $('#attention-count').textContent = items.length ? `${items.length} to review${detailSuffix}` : detailedCheckState === 'checking' ? 'Checking details…' : 'All clear';
  if (!items.length) {
    if (detailedCheckState === 'checking') {
      root.innerHTML = '<p class="muted">No failed, declined, stale, or unhealthy items detected. Checking subtitles and active Arr pipeline signals…</p>';
    } else {
      const importedChecked = detailedCheckSummary && Number(detailedCheckSummary.checked) || 0;
      const pipelineChecked = detailedCheckSummary && Number(detailedCheckSummary.pipelineChecked) || 0;
      const importedScope = detailedCheckSummary && detailedCheckSummary.truncated
        ? ` Checked the ${importedChecked} most recent imported requests for subtitles.`
        : ` Checked ${importedChecked} imported request${importedChecked === 1 ? '' : 's'} for external subtitles.`;
      const pipelineScope = detailedCheckSummary && detailedCheckSummary.pipelineTruncated
        ? ` Checked the ${pipelineChecked} most recent active requests for Arr pipeline errors.`
        : ` Checked ${pipelineChecked} active request${pipelineChecked === 1 ? '' : 's'} for Arr pipeline errors.`;
      root.innerHTML = `<p class="muted">No failed, declined, stale, unhealthy, missing-subtitle, or explicit Arr-pipeline issues detected.${importedScope}${pipelineScope}</p>`;
    }
    return;
  }
  root.innerHTML = items.map((item) => {
    const content = `<span class="attention-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message)}</small></span>`;
    return item.request
      ? `<button type="button" class="attention-item ${item.level}" data-attention-request-id="${Number(item.request.id)}">${content}${badge(item.level === 'error' ? 'Review' : 'Check')}</button>`
      : `<div class="attention-item ${item.level}">${content}${badge(item.level === 'error' ? 'Review' : 'Check')}</div>`;
  }).join('');
  root.querySelectorAll('[data-attention-request-id]').forEach((button) => {
    button.addEventListener('click', () => loadDetail(button.dataset.attentionRequestId));
  });
}

async function refreshDetailedAttentionAlerts() {
  detailedCheckState = 'checking';
  detailedCheckSummary = null;
  renderAttention();
  try {
    const data = await api('/api/attention');
    detailedAttentionAlerts = Array.isArray(data.items) ? data.items : [];
    detailedCheckSummary = data;
    detailedCheckState = 'available';
  } catch (_) {
    detailedAttentionAlerts = [];
    detailedCheckState = 'unavailable';
  }
  renderAttention();
}

function filteredRequests() {
  const title = $('#request-search').value.trim().toLocaleLowerCase();
  const status = $('#request-status').value;
  const ageHours = Number($('#request-age').value);
  const cutoff = ageHours ? Date.now() - ageHours * 60 * 60 * 1000 : null;
  return allRequests.filter((request) => {
    const titleMatches = !title || String(request.title || '').toLocaleLowerCase().includes(title);
    const statusMatches = !status || request.status === status;
    const updatedAt = Date.parse(request.updatedAt);
    const dateMatches = !cutoff || (Number.isFinite(updatedAt) && updatedAt >= cutoff);
    return titleMatches && statusMatches && dateMatches;
  });
}

function renderFilteredRequests() {
  renderRequests(filteredRequests());
}

function clearFilters() {
  $('#request-search').value = '';
  $('#request-status').value = '';
  $('#request-age').value = '';
  renderFilteredRequests();
}

function renderQueue(queue) {
  if (!queue.length) return '<p class="muted">Nothing is currently queued for this title.</p>';
  return `<ul class="plain-list">${queue.map((entry) => `
    <li>
      <strong>${escapeHtml(entry.title)}</strong><br>
      <span>${escapeHtml(entry.status)}</span>
      ${entry.progress !== null ? `<br><small>Progress: ${escapeHtml(entry.progress)}% · ${escapeHtml(formatBytes(entry.sizeleft))} remaining of ${escapeHtml(formatBytes(entry.size))}</small>` : ''}
      ${entry.eta ? `<br><small>ETA / expected completion: ${escapeHtml(entry.eta)}</small>` : ''}
      ${entry.trackedDownloadState ? `<br><small>Download state: ${escapeHtml(entry.trackedDownloadState)}</small>` : ''}
      ${entry.messages.length ? `<br><small>${entry.messages.map(escapeHtml).join(' · ')}</small>` : ''}
    </li>
  `).join('')}</ul>`;
}

function renderSidecars(sidecars) {
  if (!sidecars.length) return '<p class="muted">No external subtitle sidecars detected yet.</p>';
  return `<ul class="plain-list">${sidecars.map((name) => `<li>${escapeHtml(name)}</li>`).join('')}</ul>`;
}

function renderTimeline(timeline) {
  $('#timeline').innerHTML = timeline.map((event) => `
    <li class="${escapeHtml(event.level)}">
      <time>${formatDate(event.at)}</time>
      <div><strong>${escapeHtml(event.stage)}</strong><br>${escapeHtml(event.message)}</div>
    </li>
  `).join('');
}

function renderLinks(links) {
  const names = { seerr: 'Seerr', radarr: 'Radarr', sonarr: 'Sonarr', qbittorrent: 'qBittorrent', bazarr: 'Bazarr', lingarr: 'Lingarr', jellyfin: 'Jellyfin' };
  $('#links').innerHTML = Object.entries(links).map(([key, href]) => `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${names[key]}</a>`).join('');
}

function resetInteractive() {
  interactiveRequestId = null;
  interactiveReleases = [];
  selectedRelease = null;
  $('#interactive-search').classList.add('hidden');
  $('#search-releases').disabled = true;
  $('#release-sort').disabled = true;
  $('#release-results').innerHTML = '';
  $('#release-confirmation').classList.add('hidden');
  $('#release-confirmation').innerHTML = '';
  $('#interactive-status').textContent = 'Available only for a monitored movie with no imported file.';
}

function updateActionControls() {
  $('#unlock-actions').classList.toggle('hidden', actionUnlocked);
  $('#lock-actions').classList.toggle('hidden', !actionUnlocked);
  $('#action-passphrase').disabled = actionUnlocked;
  $('#search-releases').disabled = !actionUnlocked || !interactiveRequestId;
  $('#release-sort').disabled = !interactiveReleases.length;
}

function configureInteractive(request, arr) {
  const available = request.type === 'movie' && arr.service === 'radarr' && arr.found && !arr.hasFile;
  if (!available) return;
  interactiveRequestId = String(request.id);
  $('#interactive-search').classList.remove('hidden');
  $('#interactive-status').textContent = actionUnlocked
    ? 'Downloads are unlocked for this browser session. Search first; choosing a release still requires a separate confirmation.'
    : 'Unlock with the dashboard action passphrase to search configured indexers. Search does not start a download.';
  updateActionControls();
}

function renderReleaseResults() {
  const root = $('#release-results');
  if (!interactiveReleases.length) {
    root.innerHTML = '<p class="muted">No matching releases were returned by Radarr.</p>';
    return;
  }
  const order = $('#release-sort').value;
  const releases = interactiveReleases
    .map((release, index) => ({ release, index }))
    .sort((left, right) => {
      let difference = 0;
      if (order === 'size-desc') difference = Number(right.release.size) - Number(left.release.size);
      if (order === 'size-asc') difference = Number(left.release.size) - Number(right.release.size);
      if (order === 'seeders-desc') difference = Number(right.release.seeders) - Number(left.release.seeders);
      if (order === 'seeders-asc') difference = Number(left.release.seeders) - Number(right.release.seeders);
      return difference || left.index - right.index;
    })
    .map(({ release }) => release);
  root.innerHTML = releases.map((release) => {
    const rejected = Array.isArray(release.rejections) && release.rejections.length;
    const formats = Array.isArray(release.customFormats) && release.customFormats.length
      ? ` · Formats: ${release.customFormats.map(escapeHtml).join(', ')}`
      : '';
    const languages = Array.isArray(release.languages) && release.languages.length
      ? ` · ${release.languages.map(escapeHtml).join(', ')}`
      : '';
    const rejectionText = rejected
      ? `<div class="release-rejections">Radarr notes: ${release.rejections.map(escapeHtml).join(' · ')}</div>`
      : '';
    const action = release.manualGrabAllowed
      ? `<button type="button" data-release-token="${escapeHtml(release.token)}">Choose this release</button>`
      : '<span class="muted">This release cannot be manually submitted.</span>';
    return `
      <article class="release ${rejected ? 'rejected' : ''}">
        <div class="release-header">
          <strong class="release-title">${escapeHtml(release.title)}</strong>
          ${badge(rejected ? 'Radarr warning' : 'Available')}
        </div>
        <div class="release-meta">
          <span>${escapeHtml(release.quality || 'Unknown quality')}</span>
          <span>${escapeHtml(formatBytes(release.size))}</span>
          <span>${escapeHtml(release.seeders)} seeders</span>
          ${release.peers ? `<span>${escapeHtml(release.peers)} peers</span>` : ''}
          ${release.protocol ? `<span>${escapeHtml(release.protocol)}</span>` : ''}
          <span>${escapeHtml(release.indexer || 'Unknown indexer')}</span>
        </div>
        ${languages || formats ? `<div class="release-meta">${languages}${formats}</div>` : ''}
        ${rejectionText}
        <div>${action}</div>
      </article>
    `;
  }).join('');
  root.querySelectorAll('[data-release-token]').forEach((button) => {
    button.addEventListener('click', () => chooseRelease(button.dataset.releaseToken));
  });
}

function chooseRelease(token) {
  selectedRelease = interactiveReleases.find((release) => release.token === token) || null;
  if (!selectedRelease) return;
  const confirmation = $('#release-confirmation');
  confirmation.classList.remove('hidden');
  confirmation.innerHTML = `
    <div>
      <strong>Selected: ${escapeHtml(selectedRelease.title)}</strong>
      <p class="muted">This submits exactly this release to Radarr and then to its configured download client. It cannot be undone here.</p>
    </div>
    <button id="confirm-release" type="button">Confirm download</button>
    <button id="cancel-release" type="button" class="secondary">Cancel</button>
  `;
  $('#confirm-release').addEventListener('click', confirmRelease);
  $('#cancel-release').addEventListener('click', () => {
    selectedRelease = null;
    confirmation.classList.add('hidden');
    confirmation.innerHTML = '';
  });
}

async function unlockActions() {
  const input = $('#action-passphrase');
  const code = input.value;
  if (!code) {
    $('#interactive-status').textContent = 'Enter the dashboard action passphrase first.';
    return;
  }
  $('#unlock-actions').disabled = true;
  try {
    const result = await actionApi('/api/actions/session', { method: 'POST', body: JSON.stringify({ code }) });
    input.value = '';
    actionUnlocked = true;
    $('#interactive-status').textContent = `Downloads unlocked until ${formatDate(result.expiresAt)}. Search still does not download anything.`;
    updateActionControls();
  } catch (error) {
    input.value = '';
    $('#interactive-status').textContent = error.message;
  } finally {
    $('#unlock-actions').disabled = false;
  }
}

async function lockActions() {
  try {
    await actionApi('/api/actions/session', { method: 'DELETE' });
  } catch (_) {
    // The local UI is still locked even if an expired session cannot be cleared.
  }
  actionUnlocked = false;
  interactiveReleases = [];
  selectedRelease = null;
  $('#release-results').innerHTML = '';
  $('#release-confirmation').classList.add('hidden');
  $('#release-confirmation').innerHTML = '';
  $('#interactive-status').textContent = 'Downloads are locked for this browser session.';
  updateActionControls();
}

async function searchReleases() {
  if (!interactiveRequestId || !actionUnlocked) return;
  $('#search-releases').disabled = true;
  $('#release-results').innerHTML = '<p class="muted">Searching configured Radarr indexers…</p>';
  $('#release-confirmation').classList.add('hidden');
  $('#release-confirmation').innerHTML = '';
  selectedRelease = null;
  try {
    const data = await actionApi(`/api/request/${encodeURIComponent(interactiveRequestId)}/releases`);
    interactiveReleases = Array.isArray(data.releases) ? data.releases : [];
    $('#interactive-status').textContent = `${interactiveReleases.length} release${interactiveReleases.length === 1 ? '' : 's'} returned for ${data.title}. Nothing has been downloaded.`;
    renderReleaseResults();
  } catch (error) {
    interactiveReleases = [];
    $('#release-results').innerHTML = '';
    $('#interactive-status').textContent = error.message;
    if (/unlock/i.test(error.message)) {
      actionUnlocked = false;
      updateActionControls();
    }
  } finally {
    updateActionControls();
  }
}

async function confirmRelease() {
  if (!interactiveRequestId || !selectedRelease) return;
  if (!window.confirm(`Submit this release to Radarr?\n\n${selectedRelease.title}`)) return;
  const button = $('#confirm-release');
  button.disabled = true;
  button.textContent = 'Submitting…';
  try {
    const result = await actionApi(`/api/request/${encodeURIComponent(interactiveRequestId)}/releases/grab`, {
      method: 'POST',
      body: JSON.stringify({ releaseToken: selectedRelease.token }),
    });
    $('#interactive-status').textContent = `${result.message}: ${result.release.title}. Check the active queue for progress.`;
    interactiveReleases = [];
    selectedRelease = null;
    $('#release-results').innerHTML = '';
    $('#release-confirmation').classList.add('hidden');
    $('#release-confirmation').innerHTML = '';
  } catch (error) {
    $('#interactive-status').textContent = error.message;
    button.disabled = false;
    button.textContent = 'Confirm download';
  }
}

async function loadDetail(id) {
  $('#detail').classList.remove('hidden');
  $('#detail-title').textContent = 'Loading…';
  resetInteractive();
  $('#copy-diagnostic').disabled = true;
  $('#copy-diagnostic').dataset.requestId = '';
  $('#diagnostic-status').textContent = 'A fresh diagnostic report will be available once this request loads.';
  $('#summary').innerHTML = '';
  $('#queue').innerHTML = '';
  $('#sidecars').innerHTML = '';
  $('#timeline').innerHTML = '';
  try {
    const data = await api(`/api/request/${encodeURIComponent(id)}`);
    const { request, arr } = data;
    $('#detail-kind').textContent = `${request.type} request · Seerr #${request.id}`;
    $('#detail-title').textContent = request.title;
    $('#summary').innerHTML = [
      `<div><span>Seerr</span>${badge(request.status)}</div>`,
      `<div><span>${escapeHtml(arr.service)}</span>${arr.found ? badge(arr.hasFile ? 'Imported' : 'Monitored') : badge('Not found')}</div>`,
      `<div><span>Subtitles</span>${badge(arr.sidecars.length ? `${arr.sidecars.length} sidecars` : 'None detected')}</div>`,
    ].join('');
    $('#queue').innerHTML = renderQueue(data.queue);
    $('#sidecars').innerHTML = renderSidecars(arr.sidecars);
    renderTimeline(data.timeline);
    renderLinks(data.links);
    configureInteractive(request, arr);
    $('#copy-diagnostic').disabled = false;
    $('#copy-diagnostic').dataset.requestId = String(request.id);
    $('#diagnostic-status').textContent = 'Copy a fresh, sanitized plain-text report with health, queue progress, and correlated events.';
    $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (_) {
    $('#detail-title').textContent = 'Unable to load this request';
    $('#summary').innerHTML = '<p>The dashboard could not reach a required service. Use the direct service links and try again.</p>';
    $('#diagnostic-status').textContent = 'The diagnostic report is unavailable until this request can be loaded.';
    resetInteractive();
  }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Copy was blocked');
}

async function copyDiagnostic() {
  const button = $('#copy-diagnostic');
  const id = button.dataset.requestId;
  if (!id) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing report…';
  $('#diagnostic-status').textContent = 'Refreshing the diagnostic snapshot…';
  try {
    const response = await fetch(`/api/request/${encodeURIComponent(id)}/diagnostic.txt`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Report request failed');
    await copyText(await response.text());
    button.textContent = 'Copied';
    $('#diagnostic-status').textContent = 'Copied to the clipboard. Paste it into an AI model with your question.';
    window.setTimeout(() => { button.textContent = originalText; }, 2000);
  } catch (_) {
    button.textContent = originalText;
    $('#diagnostic-status').textContent = 'Could not copy the report. Refresh this request and try again.';
  } finally {
    button.disabled = false;
  }
}

async function refresh() {
  $('#requests').innerHTML = '<p>Refreshing requests…</p>';
  try {
    const [health, requests] = await Promise.all([api('/api/health'), api('/api/requests')]);
    renderHealth(health);
    allRequests = requests.requests;
    detailedAttentionAlerts = [];
    detailedCheckState = 'idle';
    detailedCheckSummary = null;
    renderAttention();
    renderFilteredRequests();
    void refreshDetailedAttentionAlerts();
  } catch (_) {
    $('#health').textContent = 'Dashboard cannot reach a required service';
    $('#health').className = 'health warning';
    serviceHealth = [];
    detailedAttentionAlerts = [];
    detailedCheckState = 'idle';
    detailedCheckSummary = null;
    $('#attention-count').textContent = '';
    $('#attention').innerHTML = '<p class="muted">Unable to check for issues until the dashboard can load requests.</p>';
    $('#requests').innerHTML = '<p>Unable to load requests. Check the service links or refresh.</p>';
  }
}

$('#refresh').addEventListener('click', refresh);
$('#close-detail').addEventListener('click', () => {
  $('#detail').classList.add('hidden');
  resetInteractive();
});
$('#copy-diagnostic').addEventListener('click', copyDiagnostic);
$('#unlock-actions').addEventListener('click', unlockActions);
$('#lock-actions').addEventListener('click', lockActions);
$('#search-releases').addEventListener('click', searchReleases);
$('#release-sort').addEventListener('change', renderReleaseResults);
$('#request-filters').addEventListener('submit', (event) => event.preventDefault());
$('#request-search').addEventListener('input', renderFilteredRequests);
$('#request-status').addEventListener('change', renderFilteredRequests);
$('#request-age').addEventListener('change', renderFilteredRequests);
$('#clear-filters').addEventListener('click', clearFilters);
refresh();
