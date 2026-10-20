const $ = (selector) => document.querySelector(selector);
const loginPanel = $('#login-panel');
const appPanel = $('#app-panel');
const logoutButton = $('#logout');
const notice = $('#notice');
let searchTimer = null;
let selectedItem = null;
const deepLinkItemId = new URLSearchParams(window.location.search).get('itemId');
let deepLinkOpened = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status, data });
  return data;
}
function showNotice(message, kind = '') {
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => notice.classList.add('hidden'), 7000);
}
function setSignedIn(username) {
  loginPanel.classList.add('hidden');
  appPanel.classList.remove('hidden');
  logoutButton.classList.remove('hidden');
  $('#search').focus();
  loadRequests();
  if (deepLinkItemId && !deepLinkOpened && /^[0-9a-fA-F-]{32,36}$/.test(deepLinkItemId)) {
    deepLinkOpened = true;
    inspect({ id: deepLinkItemId });
  }
}
function setSignedOut() {
  loginPanel.classList.remove('hidden');
  appPanel.classList.add('hidden');
  logoutButton.classList.add('hidden');
  $('#password').value = '';
}
function itemLabel(item) {
  if (item.type === 'Episode') return `${item.series || ''} · S${String(item.season ?? 0).padStart(2,'0')}E${String(item.episode ?? 0).padStart(2,'0')} · ${item.name}`;
  return item.year ? `${item.name} (${item.year})` : item.name;
}
function resultButton(item, label = itemLabel(item)) {
  const button = document.createElement('button');
  button.className = 'result';
  button.type = 'button';
  const title = document.createElement('span');
  title.textContent = label;
  const type = document.createElement('span');
  type.className = 'pill';
  type.textContent = item.type === 'Series' ? 'Show · choose episode' : item.type;
  button.append(title, type);
  button.addEventListener('click', () => item.type === 'Series' ? loadEpisodes(item) : inspect(item));
  return button;
}
async function search() {
  const query = $('#search').value.trim();
  const results = $('#results');
  $('#selected').classList.add('hidden');
  if (query.length < 2) { results.replaceChildren(); return; }
  results.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Searching…' }));
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
    results.replaceChildren();
    if (!data.items.length) { results.append(Object.assign(document.createElement('p'), { className: 'panel muted', textContent: 'No matching movies or episodes found.' })); return; }
    for (const item of data.items) results.append(resultButton(item));
  } catch (error) { results.replaceChildren(Object.assign(document.createElement('p'), { className: 'panel error', textContent: error.message })); }
}
async function loadEpisodes(series) {
  const results = $('#results');
  results.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Loading episodes…' }));
  try {
    const data = await api(`/api/series/${encodeURIComponent(series.id)}/episodes`);
    results.replaceChildren();
    const back = document.createElement('button'); back.className='quiet'; back.type='button'; back.textContent='← Back to search results'; back.addEventListener('click',search); results.append(back);
    const heading = document.createElement('h2'); heading.textContent = series.name; results.append(heading);
    if (!data.items.length) results.append(Object.assign(document.createElement('p'), { className: 'panel muted', textContent: 'No available episodes found.' }));
    for (const item of data.items) results.append(resultButton(item));
  } catch (error) { results.replaceChildren(Object.assign(document.createElement('p'), { className: 'panel error', textContent: error.message })); }
}
async function inspect(item) {
  selectedItem = item;
  const panel = $('#selected'); panel.classList.remove('hidden'); panel.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Checking subtitle files…' })); panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const info = await api('/api/inspect', { method: 'POST', body: JSON.stringify({ itemId: item.id }) });
    renderInspection(info);
  } catch (error) { panel.replaceChildren(Object.assign(document.createElement('p'), { className: 'error', textContent: error.message })); }
}
function renderInspection(info) {
  const panel = $('#selected'); panel.replaceChildren();
  const title = document.createElement('h2'); title.textContent = info.title; panel.append(title);
  const sub = document.createElement('p'); sub.className='muted'; sub.textContent = info.type === 'Episode' ? `${info.series} · S${String(info.season ?? 0).padStart(2,'0')}E${String(info.episode ?? 0).padStart(2,'0')}` : 'Movie'; panel.append(sub);
  const existingNames=(info.existingTargets||[]).map(code=>code==='it'?'Italian':code==='sq'?'Albanian':code);
  if(existingNames.length){const present=document.createElement('p');present.className='success';present.textContent=`Subtitle file currently present: ${existingNames.join(' and ')}.`;panel.append(present);}
  const completedNames=(info.completedTranslations||[]).map(entry=>{const name=entry.target==='it'?'Italian':entry.target==='sq'?'Albanian':entry.target;const date=entry.completedAt?new Date(entry.completedAt).toLocaleDateString():'';return date?`${name} (${date})`:name;});
  if(completedNames.length){const history=document.createElement('p');history.className='success';history.textContent=`Lingarr history says translation previously completed: ${completedNames.join(' and ')}. This is job history; it does not confirm the subtitle file still exists.`;panel.append(history);}
  if (!info.mediaAvailable) { panel.append(Object.assign(document.createElement('p'), { className: 'error', textContent: 'The video file is missing from the media folder, so no new translation can be queued. Restore or import the video to continue.' })); return; }
  if (!info.sourceAvailable) { panel.append(Object.assign(document.createElement('p'), { className: 'error', textContent: 'No English .en.srt subtitle file found. Get one with Bazarr first.' })); return; }
  const source = document.createElement('p'); source.className='success'; source.textContent=`English source found: ${info.sourceName}`; panel.append(source);
  if (info.unsafeTargets?.length) { panel.append(Object.assign(document.createElement('p'), { className: 'error', textContent: 'A subtitle output path is a symbolic link. For safety, no translation can be queued for this item.' })); return; }
  if (info.needsSync) { const warn=document.createElement('p');warn.className='muted';warn.textContent='Lingarr has not indexed this item yet. Queueing it will require a one-time scan of the matching Sonarr or Radarr library.';panel.append(warn); }
  if (!info.availableTargets.length) { if(!existingNames.length)panel.append(Object.assign(document.createElement('p'), { className: 'success', textContent: 'Italian and Albanian subtitle files already exist.' })); return; }
  const form=document.createElement('div'); form.className='choice-row';
  for (const [code,name] of [['it','Italian'],['sq','Albanian']]) {
    if (!info.availableTargets.includes(code)) continue;
    const label=document.createElement('label'); label.className='choice';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=code;checkbox.checked=true;
    const span=document.createElement('span');span.textContent=`${name} subtitle`;
    label.append(checkbox,span);form.append(label);
  }
  panel.append(form);
  const button=document.createElement('button');button.className='primary';button.type='button';button.textContent='Queue translation';
  button.addEventListener('click',async()=>{
    const targets=[...form.querySelectorAll('input:checked')].map(input=>input.value);
    if(!targets.length){showNotice('Choose at least one language.');return;}
    if(!window.confirm(`Queue ${targets.join(' and ')} translation for “${info.title}”?${info.needsSync?' This will first run a one-time library scan.':''}`))return;
    button.disabled=true;button.textContent='Submitting…';
    try {
      const data=await api('/api/requests',{method:'POST',body:JSON.stringify({itemId:info.itemId,targets,allowSync:info.needsSync})});
      showNotice('Request accepted. Lingarr will process it in the background.','success');
      panel.classList.add('hidden');loadRequests();
      for(const request of data.requests||[]) if(request.id) pollRequest(request.id);
    } catch(error){showNotice(error.message,'error');button.disabled=false;button.textContent='Queue translation';}
  });
  panel.append(button);
}
async function loadRequests(){
  try{
    const data=await api('/api/requests');
    const section=$('#requests'),list=$('#request-list');list.replaceChildren();
    for(const req of data.requests||[])list.append(requestCard(req));
    section.classList.toggle('hidden',!data.requests?.length);
  }catch(_){ }
}
function requestCard(req){
  const card=document.createElement('div');card.className='request-card';
  const title=document.createElement('strong');title.textContent=`${req.title} · ${req.targetName}`;
  const state=document.createElement('span');state.className='state';state.textContent=req.status;
  const message=document.createElement('small');message.textContent=req.message||'';
  card.append(title,state,document.createElement('br'),message);return card;
}
async function pollRequest(id){
  const end=Date.now()+20*60*1000;
  while(Date.now()<end){
    await new Promise(resolve=>setTimeout(resolve,5000));
    try{const req=await api(`/api/requests/${encodeURIComponent(id)}`);await loadRequests();if(['completed','failed','already_exists'].includes(req.status)){showNotice(`${req.title}: ${req.message}`,req.status==='completed'?'success':'');return;}}
    catch(error){if(error.status===401){setSignedOut();return;}return;}
  }
}
$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;button.textContent='Signing in…';
  try{const data=await api('/api/login',{method:'POST',body:JSON.stringify({username:$('#username').value,password:$('#password').value})});$('#password').value='';setSignedIn(data.username);}
  catch(error){showNotice(error.message,'error');}finally{button.disabled=false;button.textContent='Sign in';}
});
$('#search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(search,350);});
logoutButton.addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});}finally{setSignedOut();$('#results').replaceChildren();$('#selected').classList.add('hidden');}});
api('/api/session').then(data=>setSignedIn(data.username)).catch(()=>setSignedOut());
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
