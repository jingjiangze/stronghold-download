// 把 box/ 下需要部署的文件打包成一条 PowerShell（base64 内联），经 ssh 的 stdin 管道写进盒子。
// scp 在这条链路上会断（Connection closed by UNKNOWN port 65535），stdin 管道可用。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// 目标目录：盒子上的项目根（2026-10-09 从 C:\aiwork\spbox 搬到 D:\web\spbox，C: 只剩 5 GB）。
const DIR = 'D:\\web\\spbox';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node push.mjs <file> [file...]   （在 box/ 目录下运行）');
  process.exit(1);
}

const chunks = [];
for (const f of files) {
  const abs = path.isAbsolute(f) ? f : path.join(process.cwd(), f);
  if (!existsSync(abs)) {
    console.error(`缺少文件: ${abs}`);
    process.exit(1);
  }
  const b64 = Buffer.from(readFileSync(abs), 'utf8').toString('base64');
  const dest = path.join(DIR, path.basename(abs)).replace(/\//g, '\\');
  chunks.push(
    `$b=[Convert]::FromBase64String('${b64}');[IO.File]::WriteAllBytes('${dest}',$b);Write-Output ("wrote ${path.basename(abs)} " + $b.Length);`
  );
}

const ps = `$ErrorActionPreference='Continue';if(-not(Test-Path '${DIR}')){New-Item -ItemType Directory -Path '${DIR}' -Force|Out-Null};` + chunks.join('') + `Write-Output DONE`;
const out = path.join(process.cwd(), 'push-bundle.ps1');
writeFileSync(out, ps, 'utf8');
console.log(`已生成 ${out}（${ps.length} 字节），用：ssh wbssh 'powershell -NoProfile -NonInteractive -Command -' < push-bundle.ps1`);
