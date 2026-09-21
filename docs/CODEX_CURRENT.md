# Beta 当前交接摘要

更新时间：2026-09-21

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
