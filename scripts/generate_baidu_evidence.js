const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, '.runtime', 'baidu-indexing-evidence');
const siteOrigin = process.env.BAIDU_EVIDENCE_ORIGIN || 'https://xzmap.xzbest.site';
if (!/^https?:\/\/[^/]+$/i.test(siteOrigin)) throw new Error('Invalid BAIDU_EVIDENCE_ORIGIN');
const baiduUserAgent = 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)';

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

async function inspect(relativeUrl) {
  const url = new URL(relativeUrl, siteOrigin).href;
  const response = await fetch(url, {
    headers: { 'user-agent': baiduUserAgent },
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.text();
  return {
    url,
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    canonical: body.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)/i)?.[1] || '',
    noindex: /<meta[^>]+(?:name=["']robots["'][^>]+content=["'][^"']*noindex|content=["'][^"']*noindex[^"']*["'][^>]+name=["']robots)/i.test(body)
      || /noindex/i.test(response.headers.get('x-robots-tag') || ''),
    bytes: Buffer.byteLength(body),
  };
}

function readCoreUrls() {
  const filePath = path.join(rootDir, 'dist', 'sitemap-core.xml');
  if (!fs.existsSync(filePath)) return [];
  const xml = fs.readFileSync(filePath, 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
}

async function main() {
  const targets = ['/', '/about.html', '/destinations/index.html', '/robots.txt', '/sitemap-core.xml', '/sitemap.xml', '/definitely-not-a-real-page-928372.html'];
  const results = [];
  for (const target of targets) results.push(await inspect(target));
  const coreUrls = readCoreUrls();
  const generatedAt = new Date().toISOString();
  const rows = results.map(result => `| ${escapeCell(result.url)} | ${result.status} | ${escapeCell(result.contentType)} | ${result.bytes} | ${result.noindex ? '是' : '否'} | ${escapeCell(result.canonical || '-')} |`).join('\n');
  const report = `# 百度抓取与索引反馈证据\n\n生成时间：${generatedAt}\n\n站点：${siteOrigin}/\n\n## 自动检查\n\n| URL | HTTP | Content-Type | Bytes | Noindex | Canonical |\n| --- | ---: | --- | ---: | --- | --- |\n${rows}\n\n## 核心页面集\n\n构建中的核心 sitemap 共 ${coreUrls.length} 条 URL：\n\n${coreUrls.map(url => `- ${url}`).join('\n')}\n\n## 后台证据（人工附图）\n\n- 抓取频次：平台近 30 天未记录到抓取。\n- 抓取异常：无数据。\n- 抓取诊断：首页和目录页测试抓取成功。\n- 普通收录：曾于 2026-09-24 主动推送成功 10 条。\n- 索引量：当前为 0。\n- 服务器日志：使用 \`npm run baidu:logs -- <access.log>\` 补充真实 Baiduspider 验证结果。\n\n## 反馈文案\n\n标题：已验证新站长期未产生索引，请协助检查抓取调度\n\n站点 ${siteOrigin}/ 已在百度搜索资源平台完成验证，并通过普通收录提交核心 URL。首页及目录页抓取诊断成功，HTTP 状态码为 200；robots.txt 允许抓取，核心 sitemap 和完整 sitemap 均可访问；页面不存在 noindex，核心页面可由首页普通 HTML 链接到达。搜索资源平台近 30 天未记录到抓取，索引量仍为 0。我们已经补充站点说明、资料核验方式及核心内容入口，并修正不存在 URL 的软 404。请协助检查该站点是否存在抓取调度、站点识别或索引处理异常。\n\n请同时附上后台截图和经双向 DNS 验证的服务器日志结果；同一问题不要重复提交。\n`;
  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, 'report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`Baidu evidence report written: ${reportPath}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
