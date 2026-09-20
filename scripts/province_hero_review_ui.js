(() => {
  const state = { catalog: null, index: 0, candidateId: '', focusX: 50, focusY: 50, dirty: false, dimensions: new Map(), saving: false };
  const el = id => document.getElementById(id);
  const api = async (url, options = {}) => {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.method ? 20000 : 12000) });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || '请求失败');
    return value;
  };
  const current = () => state.catalog?.provinces?.[state.index];
  const candidate = () => current()?.candidates.find(item => item.id === state.candidateId);
  const showError = message => { el('error').textContent = message || ''; el('error').hidden = !message; };
  const dimensionText = (width, height) => width && height ? `${width} × ${height}${width < 1200 ? ' · 尺寸偏小' : width / height < 1.2 ? ' · 竖图/方图' : ''}` : '加载后显示尺寸';
  function updateProgress() {
    const { selectedCount = 0, total = 0 } = state.catalog || {};
    el('progressText').textContent = `已选择 ${selectedCount} / ${total}`;
    el('progressBar').style.width = `${total ? selectedCount / total * 100 : 0}%`;
  }
  function renderSide() {
    const list = el('provinceList'); list.innerHTML = '';
    state.catalog.provinces.forEach((province, index) => {
      const button = document.createElement('button');
      button.textContent = province.name;
      button.className = `${index === state.index ? 'active ' : ''}${province.selection ? 'done' : ''}`;
      button.onclick = () => navigate(index);
      list.appendChild(button);
    });
  }
  function applyPreview() {
    const selected = candidate();
    el('previewPanel').hidden = !selected;
    el('saveButton').disabled = !selected || state.saving;
    if (!selected) return;
    document.querySelectorAll('.preview-frame img').forEach(img => {
      img.src = selected.url;
      img.referrerPolicy = 'no-referrer';
      img.style.objectPosition = `${state.focusX}% ${state.focusY}%`;
    });
    for (const id of ['desktopLabel', 'tabletLabel', 'mobileLabel']) el(id).textContent = current().name;
    el('focusX').value = state.focusX; el('focusY').value = state.focusY;
    el('focusXValue').textContent = `${state.focusX}%`; el('focusYValue').textContent = `${state.focusY}%`;
    el('candidateGrid').querySelectorAll('.candidate').forEach(card => card.classList.toggle('selected', card.dataset.id === state.candidateId));
  }
  function render() {
    const province = current(); if (!province) return;
    location.hash = encodeURIComponent(province.id);
    state.candidateId = province.selection?.candidateId || '';
    state.focusX = province.selection?.focusX ?? 50;
    state.focusY = province.selection?.focusY ?? 50;
    state.dirty = false;
    el('title').textContent = `${province.name} · 选择头图`;
    el('currentImage').src = province.currentImage;
    el('currentImage').referrerPolicy = 'no-referrer';
    el('currentMeta').textContent = dimensionText(province.currentWidth, province.currentHeight);
    el('savedFlash').textContent = province.selection ? `已保存：${province.selection.attractionName}` : '';
    const grid = el('candidateGrid'); grid.innerHTML = '';
    province.candidates.forEach(item => {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'candidate'; card.dataset.id = item.id;
      const img = document.createElement('img'); img.src = item.url; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; img.alt = `${province.name}候选：${item.attractionName}`;
      const body = document.createElement('div'); body.className = 'body';
      const title = document.createElement('strong'); title.textContent = item.attractionName;
      const meta = document.createElement('small');
      const source = document.createElement('span'); source.className = 'pill'; source.textContent = item.source;
      const place = document.createTextNode(`${item.city || province.name}${item.level ? ` · ${item.level}` : ''}`);
      const lineBreak = document.createElement('br');
      const dimensions = document.createElement('span'); dimensions.dataset.dim = ''; dimensions.textContent = dimensionText(item.width, item.height);
      meta.append(source, place, lineBreak, dimensions);
      const check = document.createElement('span'); check.className = 'check'; check.textContent = '✓';
      body.append(title, meta); card.append(img, body, check);
      card.onclick = () => { state.candidateId = item.id; state.focusX = 50; state.focusY = 50; state.dirty = true; applyPreview(); };
      img.onload = () => {
        const width = img.naturalWidth, height = img.naturalHeight;
        state.dimensions.set(item.id, [width, height]);
        meta.querySelector('[data-dim]').textContent = dimensionText(width, height);
      };
      img.onerror = () => { card.classList.add('failed'); meta.querySelector('[data-dim]').textContent = '图片加载失败，请勿选择'; };
      grid.appendChild(card);
    });
    el('prevButton').disabled = state.index <= 0;
    el('nextButton').disabled = state.index >= state.catalog.provinces.length - 1;
    renderSide(); updateProgress(); applyPreview();
  }
  function navigate(index) {
    if (state.dirty && !confirm('当前选择尚未保存，确定离开这个省份？')) return;
    state.index = Math.max(0, Math.min(state.catalog.provinces.length - 1, index)); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function save() {
    const selected = candidate(); if (!selected || state.saving) return;
    state.saving = true; state.dirty = false; showError(''); el('saveButton').disabled = true; el('saveButton').textContent = '保存中…';
    const [width, height] = state.dimensions.get(selected.id) || [selected.width, selected.height];
    try {
      state.catalog = await api('/api/province-heroes/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ province: current().name, candidateId: selected.id, focusX: state.focusX, focusY: state.focusY, width, height }) });
      updateProgress();
      const nextUnselected = state.catalog.provinces.findIndex((item, index) => index > state.index && !item.selection);
      state.index = nextUnselected >= 0 ? nextUnselected : Math.min(state.index + 1, state.catalog.provinces.length - 1);
      render();
    } catch (error) { state.dirty = true; showError(error.message); }
    finally { state.saving = false; el('saveButton').textContent = '保存并进入下一省'; applyPreview(); }
  }
  for (const [id, key] of [['focusX', 'focusX'], ['focusY', 'focusY']]) el(id).addEventListener('input', event => { state[key] = Number(event.target.value); state.dirty = true; applyPreview(); });
  el('prevButton').onclick = () => navigate(state.index - 1); el('nextButton').onclick = () => navigate(state.index + 1); el('saveButton').onclick = save;
  window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  (async () => {
    try {
      state.catalog = await api('/api/province-heroes');
      const hash = decodeURIComponent(location.hash.slice(1));
      const fromHash = state.catalog.provinces.findIndex(item => item.id === hash);
      const firstPending = state.catalog.provinces.findIndex(item => !item.selection);
      state.index = fromHash >= 0 ? fromHash : firstPending >= 0 ? firstPending : 0;
      el('loading').hidden = true; el('screen').hidden = false; render();
    } catch (error) { el('loading').hidden = true; showError(error.message); }
  })();
})();
