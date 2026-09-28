# 百度抓取与收录处理记录

最后更新：2026-09-28

## 目标与当前结论

目标是让百度先稳定发现和抓取一小组可核验页面，再根据真实抓取日志和搜索资源平台数据判断索引处理，而不是持续重复提交全部 5,699 个 URL。

截至 2026-09-28，已确认：

- 首页、目的地目录、抽样详情页、`robots.txt` 和 `sitemap.xml` 可以公开访问；页面没有 `noindex`，canonical 指向自身。
- 百度抓取诊断曾成功，2026-09-24 主动推送曾成功接收 10 条 URL，但索引量仍为 0。
- 百度后台“抓取频次”没有数据。百度官方说明该工具的数据可能少于服务器日志，因此只能表述为“平台尚未记录到抓取”，不能单凭该图断言 Baiduspider 从未访问。
- 原站对不存在 URL 返回首页和 HTTP 200，构成软 404；同时缺少可核验的 Baiduspider 访问日志，这是本轮明确修复的技术问题。
- Google 已能 `site:` 命中首页，说明网站不是全局不可抓取；这不能替代百度自己的抓取和索引判断。

## 官方依据

- [百度链接提交](https://ziyuan.baidu.com/linksubmit/index)：提交用于缩短爬虫发现链接的时间，不保证收录。
- [百度搜索抓取与建库流程](https://ziyuan.baidu.com/college/articleinfo?id=3541)：URL 需要经过发现、抓取、建库和排序等阶段。
- [新站不收录排查](https://ziyuan.baidu.com/college/articleinfo?id=3175)：检查备案、内容质量和站点基础状态，仍异常时通过反馈中心提交证据。
- [抓取频次说明](https://ziyuan.baidu.com/college/articleinfo?id=1509)：平台统计可能与网站日志存在差异，应结合服务器日志判断。
- [Baiduspider DNS 验证](https://ziyuan.baidu.com/college/articleinfo?id=1198)：先反向解析到百度域名，再正向解析并匹配原 IP，不能只相信 User-Agent。
- [网站结构建议](https://ziyuan.baidu.com/college/articleinfo?id=27)：使用清晰的首页、频道和详情页层级及可抓取文字链接。
- [站长反馈中心规范](https://ziyuan.baidu.com/college/articleinfo?id=2004)：提交具体站点、问题、复现材料和截图，避免重复反馈。

## 2026-09-28 已实施改动

1. 首页增加无需 JavaScript 即可读取的站点说明、8 个省份入口、目的地目录和“关于本站”入口。
2. 增加 `/about.html`，公开内容范围、资料来源、核验方式、更新提醒和纠错入口。
3. 目的地目录增加 10 个重点景点的直接 HTML 链接，再连接 34 个省级目录。
4. 构建 `/sitemap-core.xml`，固定包含首页、关于页、目的地目录、10 个重点景点和 34 个省级页面，共 47 条；完整 `/sitemap.xml` 保留全部 5,699 条。
5. `robots.txt` 同时声明核心 sitemap 和完整 sitemap，核心 sitemap 排在前面。
6. Nginx 和 Node 预览服务对不存在路径返回 HTTP 404，移除首页 200 回退。
7. Nginx 示例启用 combined access log，并保留 robots 与两个 sitemap 的访问记录。
8. 增加 `npm run baidu:logs -- <access.log>`：筛选 Baiduspider UA，并用反向加正向 DNS 判断是否为真实百度爬虫。
9. 增加 `npm run baidu:evidence`：在线检查核心端点并生成反馈材料到 `.runtime/baidu-indexing-evidence/report.md`。
10. 百度主动推送改为读取核心 sitemap，默认每批 10 条，支持 `--offset`；`--all` 才发送全部 47 条。密钥只从 Git 忽略的 `.env` 读取。
11. README 首行链接到正式网站。公开 GitHub 仓库因此形成一个长期、可核验、由站点所有者维护的外部引用。

## 上线步骤

### 1. 推送正式仓库

将本次正式仓库提交推送到 `main`。服务器定时部署完成后检查：

```text
https://xzmap.xzbest.site/about.html
https://xzmap.xzbest.site/sitemap-core.xml
https://xzmap.xzbest.site/definitely-not-a-real-page-928372.html
```

前两项应为 HTTP 200，最后一项必须为 HTTP 404。

### 2. 合并宝塔 Nginx 配置

自动发布只替换构建产物，不会自动改写宝塔中的站点 Nginx 配置。需要在现有 HTTPS `server` 块中完成以下三项，然后执行 `nginx -t` 并重载：

```nginx
access_log /www/wwwlogs/xzmap.xzbest.site.log combined;

location = /sitemap-core.xml {
    try_files $uri =404;
    default_type application/xml;
}

location / {
    try_files $uri $uri/ =404;
}
```

若宝塔已经配置其他 access log 路径，保留现有路径即可，关键是日志格式包含 IP、请求、HTTP 状态和 User-Agent。不要直接覆盖现有证书、反向代理或安全配置。

### 3. 提交核心 sitemap

在百度搜索资源平台的 sitemap 入口提交：

```text
https://xzmap.xzbest.site/sitemap-core.xml
```

完整 sitemap 已提交过时无需删除，也无需每天重复提交。

### 4. 只推送有实质更新的核心页

当天有额度时，在保存真实 `BAIDU_PUSH_TOKEN` 的本地环境执行：

```powershell
npm run baidu:submit -- --dry-run
npm run baidu:submit
```

默认提交核心 sitemap 的前 10 条。只有确实需要一次性提交全部核心页且额度充足时使用 `--all`。成功响应只证明百度接收了 URL，不代表收录成功。

### 5. 检查真实抓取

部署后保留至少 7 天日志，从宝塔下载对应 access log 或压缩日志，在项目目录执行：

```powershell
npm run baidu:logs -- D:\path\to\xzmap.xzbest.site.log
```

验收时只统计 DNS 双向验证成功的 IP。User-Agent 中写有 Baiduspider 但 DNS 不匹配的请求不能当作百度抓取。

### 6. 满足条件后提交官方反馈

如果上线 7 天后同时满足以下条件，再提交一次官方反馈：

- 核心 sitemap 已成功读取；
- 首页、目录、重点详情页均为 200，随机不存在页为 404；
- 后台索引量仍为 0；
- 服务器日志中没有经 DNS 验证的真实 Baiduspider，或真实抓取持续失败。

先运行：

```powershell
npm run baidu:evidence
```

将生成的报告、百度后台抓取频次/索引量截图、抓取诊断截图和日志分析结果一起提交。相同问题不重复提交。

## 外部发现入口

外部链接可帮助发现和建立站点信号，但不能替代页面质量、抓取和索引判断。本项目采用可长期维护的入口：

1. GitHub 公开仓库 README 已链接正式站点。
2. 在 GitHub 仓库右侧 About 的 Website 字段设置 `https://xzmap.xzbest.site/`。
3. 仅在站点所有者已有且正常使用的公开主页、文章或项目资料页补充自然链接，并给出真实介绍。

不购买批量外链，不在论坛、评论区或目录站群批量发链接，不使用伪造 Baiduspider，不为提交而频繁改标题或 URL。

## 验收标准

按优先级判断进展：

1. 线上随机不存在路径稳定返回 404。
2. 服务器日志出现经 DNS 双向验证的 Baiduspider，并成功请求首页、核心 sitemap 或核心页面。
3. 百度后台开始记录抓取或索引数据。
4. 百度搜索结果能够查询到首页或核心页面。

`site:xzmap.xzbest.site` 只作为辅助检查；最终以服务器日志、百度搜索资源平台和实际搜索结果共同判断。
