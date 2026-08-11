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

`content/db.json`是景点内容维护源，只在构建阶段读取，不会发布到`dist`或公开网站。构建过程生成：

```text
data/provinces-index.json
data/provinces/*.json
data/search-index.json
```

全国核心景点缺失时，可在`content/manual-attractions*.json`中按省做人工核验补充。人工新增记录不是只补列表卡片，必须一次性完成以下三部分：

- 基本信息：地址、开放时间、票价、提示、来源和图片授权信息；
- 旅行指南：`guide_data`中的穿衣、交通、住宿、美食、长辈和儿童建议；
- 懒人攻略：完整文章式`lazy_ai_text`和可追溯`lazy_ai_source`，同时保留至少2条带节点、体力、注意事项、来源链接和核验日期的`lazy_routes`。

`scripts/generate_static_data.js`会在构建时检查以上内容；任何一部分缺失都会阻止构建，避免新版景点在详情页回退到旧模板或“补全中”。信息易变的开放时间、票价和交通安排应写明“以景区当日公告为准”，并更新`source_evidence.basicInfoUpdatedAt`和路线的`verifiedAt`。

小红书点点攻略不会直接修改全国基础库，而是写入`content/lazy-guide-overrides.json`覆盖层。双击`数据维护总控.bat`进入中文全国维护总控，主菜单只保留四项：一键数据体检、开始/继续增量补全、任务中心、生成发布数据并完整验收。已有合格点点攻略默认跳过，失败项不写入并留待下次续跑；访问受限时会安全暂停，不会反复刷新平台。

核心景点治理采用“省级清单 → 只读缺失/质量报告 → 缺失补全档案 → 可复核补全包 → 点点增量采集 → 质量闸门 → 严格验收”的流程。选择尚未建清单的指定省份时，总控会自动采集文旅部5A与国家级旅游度假区、携程热门景点和小红书长期口碑候选，再与高德5330条本地底库交叉匹配；它会先展示草稿，只有在本机输入`Y`后才批准省级清单。真实缺失景点也不会直接写入：总控先检查别名、城市、现有ID和疑似重复，完整补全包通过全部闸门后才再次询问本机批准。`npm run report:core`生成省级报告和全国汇总，`npm run report:tasks`生成统一维护任务。贵州、福建和江西是当前已验收的省级样板。

部署文件名保持ASCII，避免Windows、Linux、ZIP、Nginx和对象存储之间的中文路径编码差异。
