# 百度与 Bing 收录跟进记录

最后更新：2026-09-28 17:05（Asia/Shanghai）

## 当前事实

- Google 已能通过 `site:xzmap.xzbest.site` 找到首页。
- Bing 已读取完整 sitemap 并发现约 5.7K URL，但首页和目录仍显示“已发现但未爬网”。
- 百度已成功接收过主动提交，后台索引量仍为 0。
- 2026-09-28 才完成软 404 修复、核心入口强化、47 URL 核心 sitemap 和生产访问日志，因此可验证观察期从这一天开始。
- 线上 47 个核心 URL 已逐个检查：全部 HTTP 200、自指 canonical、无 `noindex`、主体 HTML 与站内链接可读；随机不存在 URL 返回 404。
- 截至本记录时间，生产日志中没有经双向 DNS 验证的真实 Baiduspider 或 bingbot。模拟 User-Agent 请求均被正确排除。

## 2026-09-28 本轮处理

1. 保留 `sitemap.xml` 的 5,699 个规范 URL 和 `sitemap-core.xml` 的 47 个核心 URL。两份文件均符合协议上限，暂不删除全量 sitemap。
2. 百度主动提交只使用 47 个核心页面；不重复推送 5,699 个旧 URL。
3. IndexNow 默认从核心 sitemap 读取 47 个 URL。2026-09-28 17:04 已验证线上密钥并提交，接口返回 HTTP 200。
4. IndexNow 成功提交后在 `.runtime/indexnow-submissions/` 写入 URL 批次回执；完全相同的批次默认不再重复发送。
5. 新增 bingbot 日志分析：只在 User-Agent 匹配且反向解析属于 `search.msn.com`、正向解析回原 IP 时计为真实 Bing 爬虫。
6. `npm run search:logs:remote` 现在自动下载生产 Nginx 日志，并同时验证 Baiduspider 与 bingbot。
7. 没有给 sitemap 统一写入部署日期。Bing 要求 `lastmod` 必须是页面内容真实修改时间；当前数据缺少逐 URL 的可靠更新时间，伪造当天日期会误导抓取调度。

## 不继续反复改站的原因

- 当前没有发现 robots、HTTP 状态、canonical、`noindex`、sitemap 格式或核心内链方面的硬阻断。
- 百度官方说明普通收录只能缩短链接发现时间，不能解决内容是否收录，也不保证提交后收录。
- Bing 官方建议同时使用完整 XML sitemap 和 IndexNow；5,699 URL 远低于单个 sitemap 50,000 URL 的上限。
- 继续重复提交相同 URL 或每天修改 sitemap，无法证明能提高收录，反而会破坏本次观察基线。

## 明确的时间节点

### D+3：2026-10-01 17:00 后

- 自动读取生产日志，检查真实 Baiduspider 与 bingbot。
- 如果出现 403、404、5xx 或超时，立即按请求路径修复。
- 如果真实爬虫取得 200，保持站点稳定，进入抓取后索引观察。
- 如果仍没有真实爬虫，百度执行一次抓取诊断并保存结果；Bing 检查首页、目录和抽样详情页的正式 URL 检查与实时 URL 对照。

### D+7：2026-10-05

- 百度仍无真实抓取或索引时，运行 `npm run baidu:evidence`，带核心 sitemap、HTTP 检查、提交记录、后台截图和 DNS 校验日志提交一次官方反馈。
- 如果百度已抓取但索引仍为 0，重点转为被抓页面的内容质量与模板差异证据，不扩大主动提交范围。

### Bing 发现满 14 天：2026-10-07

- 首页和目录仍为“已发现但未爬网”、日志仍无真实 bingbot 时，整理 sitemap 最后读取时间、IndexNow HTTP 200 回执、6 个 URL 检查结果和服务器日志，向 Bing Webmaster Support 提交一次问题。

## 自动命令

```powershell
npm run search:logs:remote
npm run indexnow:submit -- --dry-run
npm run baidu:evidence
```

IndexNow 核心批次已经成功接收，不要再次加 `--force`，除非这 47 个页面又发生了实质内容变化。

## 官方依据

- 百度普通收录：<https://ziyuan.baidu.com/linksubmit/index>
- Bing sitemap 与 IndexNow：<https://blogs.bing.com/webmaster/2025/7/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search/>
- Bing 验证 bingbot：<https://www.bing.com/webmasters/help/how-to-verify-bingbot-3905dc26>
- Bing 未收录排查：<https://www.bing.com/webmasters/help/why-is-my-site-not-in-the-index-2141dfab>
