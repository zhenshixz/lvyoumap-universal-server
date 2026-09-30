# Beta 当前交接摘要

更新时间：2026-09-24

## 2026-09-24 实时核对（后文 2026-09-22 内容仅作历史快照）

- 工作目录为 `D:\github\lvyoumap-universal-serverbeta`。所有开发、采集、验收先在 Beta；未经用户再次明确授权，不修改正式仓。正式仓 `D:\github\lvyoumap-universal-server` 当前工作树干净，`main` 与 `origin/main` 一致，最新提交 `369a215`（2026-09-23，更新 SEO 页面）。
- 项目为 Vue 3 前端、Node.js 健康/天气 API、Nginx 静态服务。`content/` 为维护源，`scripts/generate_static_data.js` 生成 `data/`，`scripts/build.js` 生成 `dist/` 并调用 `scripts/generate_seo_pages.js`。`dist`、`.runtime`、`.env`、`node_modules` 不同步到正式 Git。
- 截至 9 月 24 日本轮图片 Alt 修正前，Beta 的 `scripts/generate_seo_pages.js`、`content/province-heroes.json`、`content/attraction-gallery-refill-queue.json` 与正式仓对应文件 SHA-256 一致。现在 SEO 生成器仅在 Beta 新增图片 Alt 说明，尚未同步正式仓。此前“整个 SEO 功能仍仅在 Beta”的记录已经过时；线上 `robots.txt`、`sitemap.xml`、`/destinations/index.html`、`/api/health` 均返回 200。Beta 与线上 sitemap 均为 5,699 URL，线上目录页包含“进入中国旅游地图”入口。
- 补图队列当前共 397 项：`completed=141`、`not_required=250`、`pending=6`。草稿 revision `47`，也是 6 项：需手填 Trip 链接 2 项（王府井天主堂东堂、关帝庙）；网络重试 4 项（衡水湖旅游景区、阿拉善左旗东湖草原景区、李家台赶海园、马目风车露营地1号）。历史批次 `20260921-101623-050539` 的 233 项、139 个景点/401 张图已写入 Beta，勿重复应用。
- `.runtime/attraction-gallery-batch/codex-background.json` 状态为 `paused`，最后更新时间 2026-09-11；其中 PID 28580 已不存在。`.runtime/gallery-link-batches/server.json` 记录的 PID 19196 也已不存在，当前本机未监听 4210、3000、3001。旧 PID 与端口记录不可当成正在运行的服务；如要继续补图，先按现有启动器检查状态，再启动单实例。
- 省份头图人工选择为 34/34，`content/province-heroes.json` 已固化，三端共 102 张 WebP；正式仓配置文件与 Beta 一致。`docs/CODEX_MARK.md` 末尾记录了 9 月 23 日 SEO 按钮和百度验证文件的历史操作。
- 搜索平台状态以账号后台为准：历史对话显示 Google sitemap 成功读取 5,699 URL、Google 首页已收录，Bing 已发现约 5.7K URL，百度站点已验证；本次未登录各站长平台重新核验索引数量。`site:` 查询只作辅助，不能推断全部页面收录。
- 9 月 24 日截图进一步确认：Bing 目录页已发现但未爬网，实时 URL 可抓取、具备收录资格；34 张图缺 Alt 属提示，Beta 已修正并构建/本地预览通过，线上尚未更新。百度普通收录 sitemap 当日配额为 0，未能通过此入口提交；待核实 API/手动配额和抓取诊断。详见 `CODEX_MARK.md` 最新条目。
- 软著申请因新版“未使用 AI”承诺与实际开发不符，仍暂停在签章上传前；内部草稿不得直接签署提交。证据快照提交已在正式仓及 `origin/main`，本地标签 `evidence-snapshot-2026-09-22` 存在，本次远程标签查询未返回结果。
- 9 月 24 日本轮仅在 Beta 修改 SEO 生成器的图片 Alt、重新构建并做本地临时预览；没有启动采集后台任务，预览进程已停止，正式仓未修改、未提交或部署。继续工作前优先读本节，再按具体任务读取 `CODEX_MARK.md` 最近记录及对应 `.runtime` 状态；不要输出完整 JSON、日志、原图或大量 Git 文件清单到对话。
- Beta 工作树长期保留大量未提交的内容、图片和脚本；不能因为切换对话而执行清理、重置或整目录同步。任何新的同步都须先完成本轮 Beta 验收并再次取得用户明确授权。

## 当前软著申请

- 申请版本：中国旅游地图 V3.0.0；固定源码提交 `1ed403b31143fb6a14e43c1cac91a62587837c92`。
- 日期：开发完成 2026-07-23，首次发表 2026-07-24，首次发表地点中国福建省厦门市。
- 2026-09-22 已填写到官网签章页，但新版签章页要求承诺未使用 AI 编写代码、文档或申请材料；该承诺与项目实际不符，因此申请已暂停在签字上传前，尚未提交。
- `.runtime/software-copyright-20260918/` 下两份 PDF 和清单只作为内部草稿与版本证据保留，禁止直接签署承诺或上传。后续需先取得中国版权保护中心对“人主导、AI 辅助开发”的明确申报口径；不能用人工改写掩盖既有 AI 参与。

## 当前代码证据快照

- 私有清单位于 `.runtime/ip-evidence-20260922/`，公开安全说明为 `docs/IP_EVIDENCE_SNAPSHOT_2026-09-22.md`。
- 正式仓已在本人明确授权下单独提交证据说明：`ad361dc`；本地标签 `evidence-snapshot-2026-09-22`。正式仓无其他未提交改动。
- GitHub `main` 已收到证据提交 `ad361dc`，本地与 `origin/main` 一致；远程暂未查到标签。需在本人已登录的终端再执行 `git push origin evidence-snapshot-2026-09-22`。

## 工作边界

- 只改 `D:\github\lvyoumap-universal-serverbeta`，正式仓 `D:\github\lvyoumap-universal-server` 未同步。
- Beta 工作台：`http://127.0.0.1:4210/`。
- 当前仅工作台服务运行；采集、写入和 Codex 后台锁均不存在。
- 不删除线上依赖图片，不修改会话数据库；删除图片关系必须保留记录。

## 当前补图状态

- 最新批次 `20260921-101623-050539`：233 项，139 个景点 / 401 张图已写入 Beta。
- Trip 已成功但合格图不足的项目已关闭补图，不再重复跑同一链接。
- 当前新清单 revision `45`：9 项，其中 4 项需要手填 Trip 链接，5 项为网络失败重试项。
- 4 个手填项：天主教北京总教区王府井天主堂东堂、云髻山省级自然保护区、腾格里金沙海旅游度假区、关帝庙。
- 队列状态：`not_required=250`、`completed=138`、`pending=9`；补图后复审 5 项。
- 下一步：填 4 个详情页链接并保存；网络失败项可暂时跳过或从原批次快速重试。不要重复点击已应用批次的“转换成手填清单”。

## 关键文件

- `scripts/gallery_link_batch_actions.js`：队列按 Trip 结果收口、手填/重试分流。
- `scripts/gallery_link_batch_worker.js`：手填队列不再自动搜索。
- `content/attraction-gallery-refill-queue.json`：补图队列及关闭原因。
- `docs/CODEX_MARK.md`：完整历史记录，读取末尾即可。

## 验证

- `node --check`：通过。
- `node scripts/test_gallery_link_workbench.js`：通过。
- 当前服务 PID 以 `.runtime/gallery-link-batches/server.json` 为准。
## 2026-09-22 SEO 当前状态

- 线上尚未收录的核心原因已定位：缺少真实 `robots.txt` / `sitemap.xml`，5,663 个景点没有独立可抓取 URL。
- Beta 已完成静态 SEO 构建：34 个省份页、5,663 个景点页、5,699 个 sitemap URL；完整构建与校验通过。
- 本机预览：`http://127.0.0.1:3001/destinations/index.html`；robots 和 sitemap MIME 已验证正确。
- 尚未同步正式仓、未部署线上、未提交 Google Search Console 或百度搜索资源平台。
