# Beta 当前交接摘要

更新时间：2026-09-22

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
