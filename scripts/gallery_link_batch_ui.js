Vue.createApp({
  data: () => ({ page: location.hash.slice(1) || 'form', form: null, batches: [], drafts: [], historyId: '', count: 10, mode: 'new', selected: '', batch: null, error: '', message: '', saving: false, dirty: false, polling: false, busy: false, choices: {}, covers: {}, choiceBatch: '' }),
  computed: {
    filled() { return this.form?.items.filter(x => x.url).length || 0; },
    done() { return this.batch?.items.filter(x => x.done).length || 0; },
    candidateCount() { return this.applied ? this.batch.apply.imageCount : this.batch?.items.reduce((n, x) => n + x.images.filter(y => y.accepted).length, 0) || 0; },
    selectedItems() { return (this.batch?.items || []).map(i => {
      const urls = i.images.filter(im => im.accepted && this.choices[i.id + '|' + im.url]).map(im => im.url);
      const cover = this.covers[i.id]; if (urls.includes(cover)) { urls.splice(urls.indexOf(cover), 1); urls.unshift(cover); }
      return { id: i.id, urls };
    }).filter(i => i.urls.length); },
    selectedCount() { return this.selectedItems.reduce((n, i) => n + i.urls.length, 0); },
    applied() { return this.batch?.apply?.status === 'applied'; },
    applying() { return this.batch?.apply?.status === 'applying'; },
  },
  methods: {
    safeUrl(value) { try { const u = new URL(value); return u.protocol === 'https:' && ['hk.trip.com', 'cn.trip.com', 'www.trip.com'].includes(u.hostname); } catch { return false; } },
    time(value) { return value ? new Date(value).toLocaleString('zh-CN') : ''; },
    statusText(s) { return ({ running: '运行中', completed: '处理结束', interrupted: '已中断', applied: '已写入 Beta', applying: '写入与构建中' })[s] || s; },
    sourceText(s) { if (!s) return '待处理'; return s.reason || ({ collected: '已处理（来源提供 '+(s.available || 0)+' 张）', empty: '页面未提供图片', skipped: '未填写', identity_review: '实体待核对' })[s.status] || s.status; },
    media(file) { return '/media/' + this.batch.id + '/' + file; },
    displayImages(item) { const accepted=item.images.filter(x=>x.accepted&&x.thumb); if(!this.applied)return accepted; const chosen=this.batch.apply.selections?.find(i=>i.id===item.id)?.urls||[]; return chosen.map(url=>accepted.find(im=>im.url===url)).filter(Boolean); },
    itemResult(item) { if(!this.applied)return item.result||'等待处理'; const chosen=this.batch.apply.selections?.find(i=>i.id===item.id);return chosen?'已写入 '+chosen.urls.length+' 张 · 暂不补图':'本批未写入，保留原图'; },
    async api(url, options) { const r = await fetch(url, { ...options, signal: AbortSignal.timeout(options?.method ? 20000 : 8000) }); const value = await r.json(); if (!r.ok) throw Error(value.error || '请求失败'); return value; },
    post(url, input) { return this.api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); },
    async save() { this.saving = true; this.error = ''; try { this.form = await this.post('/api/draft', this.form); this.dirty = false; this.message = '已保存并确认链接，可启动采集。'; this.drafts = await this.api('/api/drafts'); } catch (e) { this.error = e.message; } finally { this.saving = false; } },
    async generate() { if (this.dirty) { this.error = '请先保存当前填写内容，再生成新清单'; return; } this.busy = true; this.error = ''; try { this.form = await this.post('/api/generate', { count: this.count, mode: this.mode, revision: this.form.revision }); this.message = '已生成 '+this.form.items.length+' 项，原清单保留在历史清单中。'; this.drafts = await this.api('/api/drafts'); } catch(e) { this.error=e.message; } finally { this.busy=false; } },
    async restore() { if (!this.historyId) return; if (this.dirty) { this.error='请先保存当前填写内容'; return; } this.busy=true; this.error=''; try { this.form=await this.post('/api/restore',{id:this.historyId,revision:this.form.revision}); this.message='已打开历史清单'; } catch(e){this.error=e.message;} finally{this.busy=false;} },
    async start() { this.busy=true; this.error=''; try { const r=await this.post('/api/start',{revision:this.form.revision}); if(r.id)this.selected=r.id; location.hash='progress'; await this.refresh(); } catch(e){this.error=e.message;} finally{this.busy=false;} },
    async applyBatch() { this.busy=true; this.error=''; try { await this.post('/api/apply',{id:this.batch.id,selections:this.selectedItems}); await this.loadBatch(); } catch(e){this.error=e.message;} finally{this.busy=false;} },
    persistChoices() { localStorage.setItem('gallery-review-'+this.batch.id,JSON.stringify({choices:this.choices,covers:this.covers})); },
    async loadBatch() {
      if (!this.selected) return;
      const next = await this.api('/api/batch?id=' + encodeURIComponent(this.selected));
      if (this.choiceBatch !== next.id) {
        this.choices={};this.covers={};
        try { const saved=JSON.parse(localStorage.getItem('gallery-review-'+next.id)); if(saved){this.choices=saved.choices||{};this.covers=saved.covers||{};} } catch {}
        this.choiceBatch=next.id;
      }
      for(const i of next.items) for(const im of i.images.filter(x=>x.accepted)) { const key=i.id+'|'+im.url; if(!(key in this.choices))this.choices[key]=true; }
      this.batch=next;
    },
    async refresh() { if (this.polling) return; this.polling = true; try { this.batches = await this.api('/api/batches'); if (!this.selected && this.batches.length) this.selected = this.batches[0].id; await this.loadBatch(); } catch (e) { this.error = '连接失败：' + e.message; } finally { this.polling = false; } },
  },
  async mounted() {
    window.addEventListener('hashchange', () => { this.page = location.hash.slice(1) || 'form'; this.refresh(); });
    window.addEventListener('beforeunload', e => { if (this.dirty) { e.preventDefault(); e.returnValue = ''; } });
    try { this.form = await this.api('/api/draft'); this.drafts = await this.api('/api/drafts'); await this.refresh(); } catch (e) { this.error = e.message; }
    setInterval(() => { if (this.page !== 'form') this.refresh(); }, 3000);
  },
}).mount('#app');
