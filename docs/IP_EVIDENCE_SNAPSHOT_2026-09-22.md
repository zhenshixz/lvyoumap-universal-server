# 中国旅游地图代码仓库证据快照（2026-09-22）

本文件记录公开 GitHub 仓库在证据文件写入前的代码状态，便于后续核验版本连续性、文件完整性与发布时间线。它不是软件著作权登记申请，也不替代司法机关对证据真实性、权属和独创性的判断。

## 仓库基准

- 仓库：`https://github.com/zhenshixz/lvyoumap-universal-server`
- 分支：`main`
- 采集时间：`2026-09-22T10:39:40+08:00`
- 基准提交：`229efa02d9bdb8e726460409fae512d1e8293b62`
- 基准 Git 树：`ea8735357042af05e07f6c6c881f4ada4b201b1e`
- 首次提交：`37f7fa64d2f64a8fb642cc3a86c7531e2f393d1d`
- 首次提交时间：`2026-07-23T11:06:20+08:00`
- 基准前提交数量：`65`
- 基准提交中的跟踪文件数量：`4335`

本文件之后产生的证据提交不属于上述 `65` 次产品提交；基准提交代表加入证据说明前的仓库状态。

## 私下保存的核验清单

权利人另行保存以下纯文本清单。这里公开其 SHA-256，以便日后验证对应文件没有被替换：

```text
9ef77b6fc2407182600777e972da08d22b28c3f522427072a113db5cde556b32  commit-history-2026-09-22.tsv
bff8ca2b43fd69b9c5a9af850ea436ac23c8ebe7d54b775450a0928bcdaa9a6d  git-refs-2026-09-22.txt
2c66cfd02e80be7c558e93d82b7f598be6c5a8628b8e16a7daac79f9e2edad41  snapshot-metadata.json
497451cd59a299f65d90155e0d96fc418c7602a067517538dd206a40c65b347c  tracked-tree-229efa0.txt
```

这些文件分别记录完整提交顺序、Git 引用、快照元数据，以及基准提交内每个跟踪文件的 Git 对象哈希和路径。服务器订单、部署日志、身份信息及其他非公开材料不上传公开仓库。

## 本地核验命令

在仓库中执行以下命令，可核对基准提交及文件树：

```bash
git show --stat 229efa02d9bdb8e726460409fae512d1e8293b62
git rev-parse 229efa02d9bdb8e726460409fae512d1e8293b62^{tree}
git rev-list --count 229efa02d9bdb8e726460409fae512d1e8293b62
git ls-tree -r --full-tree 229efa02d9bdb8e726460409fae512d1e8293b62
```

预期的 Git 树哈希为 `ea8735357042af05e07f6c6c881f4ada4b201b1e`。
