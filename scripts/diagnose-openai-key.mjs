/**
 * 临时诊断：分析 OpenAI API Key 连接失败原因（用完可删）
 *
 * 用法（不要提交密钥到 git）：
 *   在任意目录执行均可，脚本会自动 cd 到项目根（含 node_modules 的那一层）。
 *
 *   PowerShell（推荐在项目根 interview_sale）:
 *     $env:OPENAI_API_KEY="sk-..."; node scripts/diagnose-openai-key.mjs
 *
 *   若你当前在 ai-interview 子目录:
 *     $env:OPENAI_API_KEY="sk-..."; node ../scripts/diagnose-openai-key.mjs
 *
 *   或在项目根:
 *     npm run diagnose:openai-key
 *
 * 可选：与 App 相同模型
 *   $env:OPENAI_MODEL="gpt-4.1-mini"; $env:OPENAI_API_KEY="sk-..."; node scripts/diagnose-openai-key.mjs
 */

import { chdir } from 'process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, '..');
const openaiPkg = join(projectRoot, 'node_modules', 'openai');

if (!existsSync(openaiPkg)) {
  console.error('未找到 node_modules/openai，推断的项目根为：');
  console.error(' ', projectRoot);
  console.error('请从「含 package.json 的 interview_sale 根目录」运行，例如：');
  console.error('  cd ..\\..   # 若你在 ai-interview 里，先回到根目录');
  console.error('  node scripts/diagnose-openai-key.mjs');
  process.exit(1);
}

chdir(projectRoot);
const { default: OpenAI } = await import('openai');

const keyFromEnv = process.env.OPENAI_API_KEY?.trim();
const keyFromArg = process.argv[2]?.trim();
const apiKey = keyFromEnv || keyFromArg;

const model = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

function hintZh(msg) {
  const m = (msg || '').toLowerCase();
  const hints = [];
  if (/401|incorrect api key|invalid api key|invalid_request_error.*authentication/i.test(msg)) {
    hints.push('→ 疑似密钥错误、已撤销、或复制时多了空格/换行。');
  }
  if (/403|forbidden|not allowed|country|region|unsupported/i.test(msg)) {
    hints.push('→ 疑似地区/组织策略限制或账号权限。');
  }
  // insufficient_quota 也带 429，优先说明计费，避免和「RPM 限流」混淆
  if (/insufficient_quota|exceeded your current quota|billing details/i.test(msg)) {
    hints.push('→ 账号 API 额度/余额不足或未开通计费：打开 platform.openai.com → Billing 绑卡或充值后再试（换模型通常无法解决）。');
  } else if (/429|rate limit/i.test(m)) {
    hints.push('→ 触发请求频率限流（RPM 等），稍后再试或提高套餐限额。');
  }
  if (/402|payment method|no payment/i.test(msg) && !/insufficient_quota/i.test(msg)) {
    hints.push('→ 可能需要添加支付方式。');
  }
  if (/model.*not found|does not exist|not have access|invalid_model/i.test(msg)) {
    hints.push(`→ 当前模型「${model}」对该账号不可用，在 App 设置里改成 gpt-4o-mini 再测。`);
  }
  if (hints.length === 0) hints.push('→ 对照上方 status / code / message 排查，或把脱敏后的报错发给开发者。');
  return hints.join('\n');
}

function printErr(label, e) {
  console.log(`\n--- ${label} 失败 ---`);
  const status = e?.status ?? e?.response?.status;
  const inner = e?.error;
  const msg = e?.message ?? String(e);
  console.log('HTTP status:', status ?? '(无)');
  if (e?.request_id) console.log('x-request-id:', e.request_id);
  if (e?.code) console.log('error.code:', e.code);
  if (e?.type) console.log('error.type:', e.type);
  if (inner && typeof inner === 'object') {
    console.log('error (object):', JSON.stringify(inner, null, 2));
  }
  if (e?.response?.data && !inner) {
    console.log('response.data:', JSON.stringify(e.response.data, null, 2));
  }
  console.log('message:', msg);
  console.log(hintZh(msg + ' ' + JSON.stringify(inner || '')));
}

async function main() {
  console.log('OpenAI Key 诊断（临时脚本）');
  console.log('项目根目录:', projectRoot, '\n');

  if (!apiKey) {
    console.error('未提供密钥。请设置 OPENAI_API_KEY，例如：');
    console.error('  $env:OPENAI_API_KEY="sk-..."; node ../scripts/diagnose-openai-key.mjs');
    console.error('（在 ai-interview 目录时路径用 ..\\scripts\\…；在根目录用 scripts\\…）');
    process.exit(1);
  }

  if (keyFromArg && !keyFromEnv) {
    console.warn('⚠ 使用命令行传参可能留在 shell 历史中，建议改用 $env:OPENAI_API_KEY。\n');
  }

  console.log('Key 前缀:', apiKey.slice(0, 12) + '…（长度 ' + apiKey.length + '）');
  if (!apiKey.startsWith('sk-')) {
    console.warn('⚠ 正常 OpenAI 密钥一般以 sk- 或 sk-proj- 开头。\n');
  }

  const client = new OpenAI({ apiKey });

  console.log('\n[1/2] 请求 GET /v1/models（前几项）…');
  try {
    const list = await client.models.list();
    const ids = (list.data || []).map((x) => x.id).slice(0, 8);
    console.log('成功。示例 model id:', ids.length ? ids.join(', ') : '(列表为空)');
  } catch (e) {
    printErr('GET /v1/models', e);
  }

  console.log('\n[2/2] 请求 chat.completions（与 App 测试连接一致，model=' + model + '）…');
  try {
    await client.chat.completions.create({
      model,
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Hi' }]
    });
    console.log('成功。该 Key 使用模型「' + model + '」可正常调用。');
  } catch (e) {
    printErr('chat.completions', e);
    const code = e?.code ?? e?.error?.code;
    const isQuota = code === 'insufficient_quota' || /insufficient_quota/i.test(e?.message ?? '');
    if (model !== 'gpt-4o-mini' && !isQuota) {
      console.log('\n若是「模型不可用」类错误，可再试（不换 Key，只换模型）：');
      console.log('  $env:OPENAI_MODEL="gpt-4o-mini"; $env:OPENAI_API_KEY="…"; node scripts/diagnose-openai-key.mjs');
    }
  }

  console.log('\n完成。');
}

await main().catch((e) => {
  console.error(e);
  process.exit(1);
});
