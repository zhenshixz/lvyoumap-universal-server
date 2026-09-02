# Lvyoumap Universal Server

这是中国旅游地图的通用云服务器版本。它不绑定阿里云、腾讯云、宝塔或特定CDN。

项目架构、数据分层、小红书点点采集、贵州试点状态、验证和回撤规则统一记录在 [PROJECT_MAINTENANCE.md](PROJECT_MAINTENANCE.md)。后续数据迭代请先阅读该文件。

## 运行结构

- Nginx直接提供`dist`中的页面、地图数据和图片。
- Node.js仅提供`/api/health`和`/api/weather`。
- 实时天气失败时，前端保留随版本发布的气候参考数据，网站不会白屏。
- 默认由服务器定时检查GitHub，发现新提交后才构建、健康检查和原子切换。
- GitHub Actions推送部署作为可选方案保留。

## 本地运行

要求Node.js 24 LTS或更新版本。

Windows可直接双击：

```text
start_universal_server.bat
```

也可以在终端执行：

```powershell
npm ci
npm run verify
npm start
```

访问：

```text
http://127.0.0.1:3000
http://127.0.0.1:3000/api/health
http://127.0.0.1:3000/api/weather?province=北京
```

## 天气来源

默认`WEATHER_PROVIDER=auto`：

1. 配置和风天气时优先使用和风天气。
2. 未配置时使用Open-Meteo作为零配置实时天气。
3. 上游失败时尝试wttr.in。
4. 全部失败时，浏览器继续显示静态参考天气。

生产环境推荐在`/etc/lvyoumap.env`中配置和风天气专属API Host和JWT凭据。真实凭据、私钥和`.env`禁止提交Git。

## 通用Linux部署

运行时只依赖：

- 主流Linux系统与systemd
- Node.js 24 LTS
- Nginx
- curl、tar和SSH

标准目录：

```text
/opt/lvyoumap/releases/   历史版本
/opt/lvyoumap/current     当前版本软链接
/var/lib/lvyoumap         持久化目录
/etc/lvyoumap.env         服务器环境配置
```

`deploy/bootstrap.sh`完成一次性服务器初始化；`deploy/activate-release.sh`负责原子发布、健康检查和失败回滚。宝塔存在时只需要把`deploy/nginx-site.conf`中的两个`location`规则合并到站点配置。

## GitHub Desktop自动部署

页面底部会从当前线上版本的 `build-info.json` 读取时间，以小字显示“月-日 时:分 更新”。该文件随每次成功构建进入当前发布版本；读取失败时自动隐藏，不影响地图和实时天气。

公开仓库默认不需要GitHub Token、Actions Secrets或云厂商插件。`bootstrap.sh`会安装
`lvyoumap-update.timer`，服务器约每30秒检查一次`main`：

```bash
sudo systemctl enable --now lvyoumap-update.timer
sudo systemctl start lvyoumap-update.service
```

以后只需通过GitHub Desktop完成`Commit to main`并点击`Push origin`。远端提交没有变化时不会重新构建；
发现更新后使用服务器上的Git镜像增量拉取。小改动通常可在约1分钟内上线，实际时间仍受GitHub网络速度影响。
构建或健康检查失败时继续保留上一版。

仓库地址和分支可在`/etc/lvyoumap.env`中通过以下变量调整：

```text
LVYOUMAP_REPOSITORY
LVYOUMAP_BRANCH
```

## 可选的GitHub Actions推送部署

工作流位于`.github/workflows/deploy-server.yml`。默认只构建和保存部署产物，不会连接服务器。

准备好服务器后，在GitHub创建变量：

```text
ENABLE_SERVER_DEPLOY=true
```

并创建以下Secrets：

```text
DEPLOY_HOST
DEPLOY_PORT
DEPLOY_USER
DEPLOY_SSH_KEY
DEPLOY_KNOWN_HOSTS
```

推送`main`后会自动构建、上传和切换版本。部署后的`/api/health`检查失败时，服务器自动恢复上一版本。

## 数据维护

全国核心景点补全采用三级质量门禁：身份错配、重复、关键字段/攻略/路线缺失会阻断；第二来源或授权实景图暂缺仅作为隔离预览警告；体验增强项进入后续任务。警告不会被静默忽略，最终写入 beta 前仍需人工查看隔离预览并确认。完整规则见 [PROJECT_MAINTENANCE.md](PROJECT_MAINTENANCE.md)。

`content/db.json`是景点内容维护源，只在构建阶段读取，不会发布到`dist`或公开网站。构建过程生成：

```text
data/provinces-index.json
data/provinces/*.json
data/search-index.json
```

全国核心景点缺失时，可在`content/manual-attractions*.json`中按省做人工核验补充。人工新增记录不是只补列表卡片，必须一次性完成以下三部分：

- 基本信息：地址、开放时间、票价、提示、来源和图片授权信息；
- 旅行指南：`guide_data`中的穿衣、交通、住宿、美食、长辈和儿童建议；
- 懒人攻略：完整文章式`lazy_ai_text`和可追溯`lazy_ai_source`，同时保留至少1条带真实游览顺序或重点、体力、注意事项、来源链接和核验日期的`lazy_routes`；确有明显不同玩法时再补第二条，不按固定节点数凑数。

`scripts/generate_static_data.js`会在构建时检查以上内容；任何一部分缺失都会阻止构建，避免新版景点在详情页回退到旧模板或“补全中”。信息易变的开放时间、票价和交通安排应写明“以景区当日公告为准”，并更新`source_evidence.basicInfoUpdatedAt`和路线的`verifiedAt`。

小红书点点攻略不会直接修改全国基础库，而是写入`content/lazy-guide-overrides.json`覆盖层。双击`数据维护总控.bat`进入中文全国维护总控，主菜单只保留四项：一键数据体检、开始/继续增量补全、任务中心、生成发布数据并完整验收。已有合格点点攻略默认跳过，失败项不写入并留待下次续跑；访问受限时会安全暂停，不会反复刷新平台。

逐省核心补全完成后，单源观察池不需要再逐省重跑。进入`任务中心 → 全国单源观察池批量补选`，可输入`rec`选择推荐项、`all`选择全部，或输入`1,3-8`一次选择任意景点。确认一次后，系统按省份复用原完整流水线并在后台断点补全；单省失败不会阻断其他省份。完成后从同一入口打开一个全国统一隔离预览，检查成功项后再输入一次`Y`，才会写入 beta。选择动作只代表人工确认“值得纳入”，不再强制补出第二个热度来源；实体、城市、重复、基本资料、真实图片、旅行指南和点点攻略仍按原质量规则校验。批次快照和状态保存在`.runtime/observation-batches`，可续跑、可追溯，不得同步到正式 Git。

核心景点治理采用“省级清单 → 只读缺失/质量报告 → 缺失补全档案 → 可复核补全包 → 点点增量采集 → 质量闸门 → 严格验收”的流程。选择尚未建清单的指定省份时，总控会自动采集文旅部5A与国家级旅游度假区、携程热门景点和小红书长期口碑候选，再与高德5330条本地底库交叉匹配；首轮单源重要候选会继续用城市级携程分页、高德唯一POI和官方身份进行二次补证，旧证据或未覆盖本轮候选的残缺证据不能通过状态一致性检查。二次补证后仍只有一个来源的候选保留在观察池，其中省榜高位项标记为优先观察，但不会阻断本省其他已确认景点；只有来源链路缺失、官方硬基线异常或已入选项出现身份/城市/证据错误才阻断审批。总控只展示最终草稿，只有在本机输入`Y`后才批准省级清单。大众点评目前无稳定公开检索接口，只预留可核验公开页面证据，不作为无人值守流程的硬依赖。真实缺失景点也不会直接写入：总控先检查别名、城市、现有ID和疑似重复，完整补全包通过全部闸门后才再次询问本机批准。`npm run report:core`生成省级报告和全国汇总，`npm run report:tasks`生成统一维护任务。北京、福建、广东、贵州和江西已通过完整资料验收；截至2026-08-13，全国已验收核心清单合计120条，其中北京23/23。

当核心清单已批准、但该省还没有完整核验资料时，总控会建立 `researching` 研究任务，而不是要求事先手工创建一个省级种子文件或直接报错。研究阶段可先断点采集点点攻略；基本信息、至少1条真实可执行游览方案、至少两个事实来源以及许可明确的图片仍必须分别核验，通过后才进入 `collecting/reviewed/applied`。路线节点可按景点实际使用楼层、展区、街区、观赏重点或活动顺序，不设置固定数量。主菜单 `[2] 开始 / 继续增量补全`会自动执行所需体检，所以同一省续跑时无需固定先按一次`[1]`。

实际使用只需两步：第一次在总控选择 `[2]` 和省份，程序会自动完成懒人攻略、结构化路线、官方/OTA身份与基本资料交叉核验、许可图片下载、质量门禁和隔离预览；预览确认无误后，再次选择 `[2]` 和同一省份并输入 `Y`，才会写入 beta 内容层。中途登录失效、网络失败或关机都保留断点，再选 `[2]` 即可续跑；已经完整的景点和阶段不会重复联网。人工省级证据文件仅用于疑难景点覆盖，不再是全国补全的前置条件。

总控使用统一的全国容错策略，不再为每个省编写专用判断：子任务完整完成记为成功；网络抖动、点点回答不完整或个别来源暂缺属于可恢复状态，会自动短重试并复用逐景点断点；普通单源候选和非关键增强项进入观察池或警告，不阻断整省。只有小红书登录/访问限制、安全停止、景点身份或城市冲突、程序结构错误等关键问题才暂停。自动重试后仍未完成时，只需在总控再次选择 `[2]` 和同一省份，系统会从失败项继续，不需要修改文件或回到对话中请求补丁。

高德在线评分为可选增强层。在 beta 根目录创建不会提交到 Git 的 `.env`，写入 `AMAP_WEB_SERVICE_KEY=你的Web服务Key`；总控优先使用实体已绑定的 POI ID，并复核名称和城市，缺少 ID 时才使用城市限定检索。已有可靠 OTA 评分不会被覆盖；无唯一同实体结果时保持“暂无公开评分”，不会生成假星级。`.env`、`.runtime`、`dist`、`release`和`node_modules`均不得从 beta 同步到正式 Git。

本地验收请双击 `start_dev.bat`。该启动器使用稳定 Node 服务而不是监听全目录的 nodemon，启动前检查路径、Node 和构建产物；缺少 `dist` 时自动构建。启动成功后会显示 `http://127.0.0.1:3000`、可用的局域网地址和健康检查结果。手机和平板需与电脑连接同一局域网并访问显示的 LAN 地址。

日常流程固定为：只在 `lvyoumap-universal-serverbeta` 运行总控和验收；确认后将源代码、审核内容和图片同步到 `lvyoumap-universal-server`，再通过 GitHub Desktop 提交。可安全重新生成并清理的目录是 `dist`、`.runtime/previews`和旧 `release`发布包；不得清理 `.runtime/xhs-profile`、断点状态、审核证据或备份，否则会丢失登录态或续跑能力。

需要把已验收的 beta 内容复制到正式 Git 时，可在 beta 根目录双击 `sync_to_formal_git.bat`。使用前必须先在总控执行 `[4] 生成发布数据并完整验收`；工具会核对全国报告、构建时间和 GitHub 单文件大小限制，避免把未验收、构建已过期或无法推送的内容带入正式仓。随后自动比较两个目录，只同步程序、审核内容、生成数据和资源文件中的新增/变化项；`.runtime`、`dist`、`reports`、`node_modules`、`.env`、日志及临时文件始终排除。复制前会显示完整清单并要求输入一次 `Y`，覆盖文件会备份到 `.runtime/promotion-backups`，复制后逐文件校验。工具不会提交、推送或部署，完成后仍由使用者在 GitHub Desktop 中检查并提交。

部署文件名保持ASCII，避免Windows、Linux、ZIP、Nginx和对象存储之间的中文路径编码差异。
