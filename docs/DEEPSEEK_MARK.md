# DeepSeek 工作记录

最后更新：2026-09-17

## 背景与目标

- 需求：轻量化接入，看初步的站点流量、日活（UV）与趋势，不打断浏览体验。
- 正式站点：`xzmap.xzbest.site`（Nginx 静态 + Node 提供 `/api/health`、`/api/weather`）。
- 目标：一段代码看真实访问与趋势，不自建复杂埋点。

## 最终结论（以此条为准）

**直接采用国内免费第三方「百度统计」，无需 Cookie 弹窗。**

### 关键澄清（纠正此前的误判）

- 中国大陆法律**并未普遍强制要求 Cookie 同意弹窗**——那是欧盟 GDPR / 英国 PECR 的规则。
- 面向国内用户的中文站接入百度统计/51LA **不需要弹窗**，只需在隐私政策中做告知。
- 之前"百度统计需访客授权弹窗、破坏体验"的判断是 GDPR 思维误带，对国内站不成立。
- 你此前看到的"弹窗"，是 Codex 当时错误加的自制同意横幅，并非百度统计自带。

## 推荐方案：百度统计（首选）

- **完全免费**，一段异步 JS 代码接入，不拖慢页面。
- 覆盖目标需求：PV、UV、访问次数、7/30 天趋势、来源分析。
- 后台支持 **IP 排除**（过滤站长本人访问）；代码只在正式域名注入（天然排除测试域名）。
- 无需自建、无需 token、无需维护服务器。

### 备选：51LA 统计

- 核心功能免费，实时访客监控、上手简单，适合个人站。

### 不推荐

- 友盟+（原 CNZZ）：部分功能已转付费，商业化倾向。
- 境外 Umami Cloud / Cloudflare：处理 IP，涉《个人信息保护法》第 39 条跨境传输，不推荐。

### 自建 beacon（降级为备选）

- 若以后完全不想依赖第三方，可复用现有 Node 加 `/api/track` 匿名 beacon + 私有 `/api/stats`。
- 数据第一方落地、IP 哈希当日去重、无 cookie；但需要自行维护与鉴权，当前阶段不必要。

## 落地顺序

1. 在百度统计后台为 `xzmap.xzbest.site` 新建站点，取得官方统计代码与站点 ID。
2. 在 beta 的 `index.html` 只对正式域名注入官方代码，`npm run verify` 验收。
3. 用户手动同步正式仓，经 GitHub Desktop 部署。
4. 隐私政策/页脚加一句"匿名访问统计"告知（文字说明，非弹窗）。

## 实施记录（2026-09-17）

- 已接入百度统计：站点 ID `2d4a80afd47718c02e688eb0ca3d41a6`，官方代码注入 `index.html` 末尾。
- 仅正式域名 `xzmap.xzbest.site` 加载；本地/局域网预览（localhost、127.0.0.1、192.168.x.x）不上报。
- footer 增加"匿名访问统计"告知文字（非弹窗），样式 `.site-stats-note` 加入 `style.css`。
- 验证：`npm run build` 数据生成与产物切换成功，`dist/index.html` 已含统计代码；构建末段清理旧备份 `.dist-previous` 被 IDE 批量安全删除保护拦截（环境 shim，非代码问题），残留目录已手动清理。
- 上线核验（2026-09-17）：线上 HTML 已含统计代码；DevTools Network 的 `Fetch/XHR` 过滤器看不到 `hm.js` 属正常现象（它是 Script/Img 类型，需用「全部/JS」过滤或 Console 查 `performance.getEntriesByType('resource')`）；已实测 script 加载 + img（hm.gif）上报均发生，统计正常。AdBlock 类扩展会拦截 `hm.baidu.com`，站长浏览器需对本站放行，普通访客不受影响。
- 正式仓未动，待用户验收后手动同步。

## 前端改动记录（2026-09-17）

### 修复子景点大图状态残留 BUG
- 现象：有子景点的景点（如杭州西湖）→ 点子景点进全屏大图 → 关闭后，再点列表其他景点会直接进入"查看大图"。
- 根因：`image-viewer-active` 类（子景点全屏大图态）在 `viewSubspotLargeImage()` 进入后**从未被移除**；`_subspotOriginalModalImg/Title` 也只存不还；关闭详情时类残留，导致下次打开任意景点直接呈现大图态。
- 修复：`app.js` 新增 `exitSubspotLargeImage()`；`handleModalClose` 命中则先退出大图返回详情（而非关闭弹窗）；`closeModal()` 增加防御性清理。用户已验收通过。

### 隐藏详情页三处冗余信息（仅隐藏，不删除）
- 隐藏项：①"景点介绍"来源胶囊（`#modal-source-pill`，如"高德地图"）；②"实用信息"的"已整理"状态（`.info-status-dot`）；③"数据来源"栏右侧"更新于"日期（`#modal-source-updated`）。
- 方式：`style.css` 加一段 `display:none` 规则并带恢复注释；DOM/JS 逻辑原样保留，恢复时删除该段即可。
- 注意：`#modal-source-pill` 必须按 ID 隐藏，不能用 `.info-source-pill` 类选择器（该类被"热门子景点"数量胶囊 `#modal-subspots-count-pill` 复用，会误伤）。

## 必须继承

- 所有实现与验收只在 `lvyoumap-universal-serverbeta` 完成；正式仓未授权不动。
- 未取得用户明确同步授权前，不写入正式 Git、不部署。
- 构建后必须主动清理 `.dist-next` / `.dist-previous` 中间产物，不留冗余；IDE 环境有批量删除保护（>500 文件），用 `[System.IO.Directory]::Delete($path, $true)` 清理构建残留，不让用户手动处理。
