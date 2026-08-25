const readline = require('readline');
const { execFileSync } = require('child_process');
const pipeline = require('./food_pipeline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = question => new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));

function parseIndexes(input) {
  const values = new Set();
  for (const part of input.split(/[,，\s]+/).filter(Boolean)) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    for (let value = Math.min(start, end); value <= Math.max(start, end); value += 1) values.add(value);
  }
  return [...values];
}

async function main() {
  process.title = '中国旅游地图 - 全国美食数据总控';
  while (true) {
    console.clear();
    console.log('中国旅游地图 - 全国美食数据总控');
    console.log('========================================');
    console.log('[1] 全国补全 / 继续（自动保存断点）');
    console.log('[2] 隔离预览 / 确认');
    console.log('[3] 写入 beta / 构建校验');
    console.log('[0] 退出');
    const choice = await ask('请选择：');
    try {
      if (choice === '0') break;
      if (choice === '1') {
        const batch = await pipeline.collect();
        console.log(`完成：可预览 ${batch.items.filter(item => item.status === 'ready').length} 条，待续跑 ${batch.items.filter(item => item.status === 'retry').length} 条。`);
      } else if (choice === '2') {
        const result = pipeline.openPreview();
        console.log(`已打开隔离预览，共 ${result.ready.length} 条。`);
        const confirmed = await ask('输入 Y 全部确认；需排除时输入编号（如 2,5-8）；其他内容取消：');
        if (/^y$/i.test(confirmed)) {
          pipeline.approve([]);
          console.log('已确认全部可预览项目。');
        } else if (/\d/.test(confirmed) && parseIndexes(confirmed).length) {
          const excluded = parseIndexes(confirmed);
          pipeline.approve(excluded);
          console.log(`已确认，其中文号 ${excluded.join('、')} 不写入。`);
        }
      } else if (choice === '3') {
        // 写入主库安全保障
        const batch = pipeline.readJson(pipeline.batchPath);
        if (!batch || !batch.approvedAt) {
          throw new Error('请先在菜单 [2] 中查看“隔离预览”并输入 Y 确认后，方可执行写入。');
        }
        const result = pipeline.publish();
        console.log(`已写入 ${result.added} 条，正在构建校验……`);
        execFileSync(process.execPath, ['scripts/build.js'], { cwd: require('path').resolve(__dirname, '..'), stdio: 'inherit' });
        execFileSync(process.execPath, ['scripts/verify-build.js'], { cwd: require('path').resolve(__dirname, '..'), stdio: 'inherit' });
        console.log('写入与构建校验完成。');
      } else console.log('请输入 0-3。');
    } catch (error) {
      console.error(`处理失败：${error.message}`);
    }
    await ask('按回车键返回主菜单……');
  }
  rl.close();
}

main().catch(error => { console.error(error); rl.close(); process.exitCode = 1; });
