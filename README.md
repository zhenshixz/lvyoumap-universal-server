# Lvyoumap Universal Server

这是中国旅游地图的通用云服务器版本。它不绑定阿里云、腾讯云、宝塔或特定CDN。

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
`lvyoumap-update.timer`，服务器每5分钟检查一次`main`：

```bash
sudo systemctl enable --now lvyoumap-update.timer
sudo systemctl start lvyoumap-update.service
```

以后只需通过GitHub Desktop提交并Push。远端提交没有变化时不会重新构建；构建或健康检查失败时继续保留上一版。

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

部署文件名保持ASCII，避免Windows、Linux、ZIP、Nginx和对象存储之间的中文路径编码差异。
