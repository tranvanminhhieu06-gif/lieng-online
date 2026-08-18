import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Đảm bảo PATH có chứa thư mục Git trên Windows
const possibleGitPaths = [
  'C:\\Program Files\\Git\\mingw64\\libexec\\git-core',
  'C:\\Program Files\\Git\\cmd',
  'C:\\Program Files\\Git\\usr\\bin',
  'C:\\Program Files\\Git\\bin',
  'C:\\Program Files (x86)\\Git\\cmd',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd')
];

for (const p of possibleGitPaths) {
  if (fs.existsSync(p) && !process.env.PATH.includes(p)) {
    process.env.PATH = `${p};${process.env.PATH}`;
  }
}

const directGitExe = [
  'C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\git.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files\\Git\\bin\\git.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe')
].find(p => fs.existsSync(p)) || 'git';

function runGit(args, options = {}) {
  try {
    return execSync(`"${directGitExe}" ${args}`, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      stdio: options.stdio || 'pipe',
      env: process.env,
      ...options
    });
  } catch (error) {
    if (options.ignoreError) return null;
    throw error;
  }
}

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function getChangedFiles() {
  const status = runGit('status --porcelain', { ignoreError: true }) || '';
  if (!status) return [];
  return status
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^([MADRCU?!\s]{1,2})\s+(.+)$/);
      if (!match) return { status: 'M', file: line };
      return { status: match[1].trim(), file: match[2].trim() };
    });
}

function getCurrentBranch() {
  try {
    const branch = runGit('branch --show-current', { ignoreError: true });
    return (branch && branch.trim()) || 'main';
  } catch {
    return 'main';
  }
}

function pushChanges(customMessage = null, isInteractive = true) {
  console.log(`\n[${getTimestamp()}] 🔍 Đang kiểm tra trạng thái Git...`);
  
  const changedFiles = getChangedFiles();
  
  // Kiểm tra xem có commit nào chưa push không
  let unpushedCommits = '';
  try {
    unpushedCommits = runGit('log origin/main..HEAD --oneline', { ignoreError: true }) || '';
  } catch {
    // Chưa có tracking branch
  }

  if (changedFiles.length === 0 && !unpushedCommits.trim()) {
    console.log(`✅ [${getTimestamp()}] Working tree sạch và không có commit mới nào cần đẩy.`);
    return false;
  }

  if (changedFiles.length > 0) {
    console.log(`📝 Phát hiện ${changedFiles.length} file có thay đổi:`);
    changedFiles.slice(0, 8).forEach(f => {
      console.log(`   - [${f.status}] ${f.file}`);
    });
    if (changedFiles.length > 8) {
      console.log(`   ... và ${changedFiles.length - 8} file khác`);
    }

    // Tạo commit message nếu không truyền vào
    let commitMsg = customMessage;
    if (!commitMsg) {
      const fileSummary = changedFiles
        .slice(0, 3)
        .map(f => path.basename(f.file))
        .join(', ');
      const extra = changedFiles.length > 3 ? ` (+${changedFiles.length - 3} files)` : '';
      commitMsg = `Auto-update [${getTimestamp()}]: ${fileSummary}${extra}`;
    }

    try {
      console.log(`⏳ Đang thực hiện git add...`);
      runGit('add -A');

      console.log(`💾 Đang commit: "${commitMsg}"`);
      runGit(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
    } catch (err) {
      console.error(`❌ Lỗi khi commit:`, err.message);
      return false;
    }
  }

  const branch = getCurrentBranch();
  console.log(`🚀 Đang đẩy code lên branch '${branch}'...`);

  const remotes = runGit('remote', { ignoreError: true });
  if (!remotes || !remotes.includes('origin')) {
    console.warn(`⚠️ Chưa thiết lập remote 'origin'. Vui lòng dùng lệnh: git remote add origin <url>`);
    return false;
  }

  let pushSuccess = false;
  try {
    execSync(`git push -u origin ${branch}`, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: process.env
    });
    pushSuccess = true;
  } catch {
    pushSuccess = false;
  }

  if (pushSuccess) {
    console.log(`🎉 [${getTimestamp()}] Đã đẩy code lên Git thành công!`);
    return true;
  } else {
    console.log(`\n⚠️ Chưa thể push lên GitHub tự động.`);
    console.log(`💡 Hướng dẫn xử lý:`);
    console.log(`   1. Nhấp đúp vào file 'autopush.bat' trên Desktop/Thư mục dự án.`);
    console.log(`   2. Hoặc tạo GitHub Personal Access Token (PAT) tại https://github.com/settings/tokens`);
    console.log(`   3. Chạy lệnh: git push`);
    return false;
  }
}

// Chế độ Watch (theo dõi file tự động)
function startWatchMode(debounceMs = 15000) {
  console.log(`\n==================================================`);
  console.log(`👀 Chế độ Tự Động Đẩy (Watch Mode) đã bật!`);
  console.log(`📁 Theo dõi thư mục: ${ROOT_DIR}`);
  console.log(`⏱️ Thời gian gom thay đổi (debounce): ${debounceMs / 1000}s`);
  console.log(`Nhấn Ctrl + C để dừng theo dõi.`);
  console.log(`==================================================\n`);

  let debounceTimer = null;
  let isPushing = false;

  const ignoredPaths = [
    'node_modules',
    '.git',
    'lieng.db',
    'lieng.db-wal',
    'lieng.db-shm',
    '.env',
    '.env.local'
  ];

  function shouldIgnore(filePath) {
    if (!filePath) return false;
    const rel = path.relative(ROOT_DIR, filePath);
    return ignoredPaths.some(ignored => rel.startsWith(ignored) || rel.includes(path.sep + ignored));
  }

  try {
    fs.watch(ROOT_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename || shouldIgnore(filename)) return;

      if (debounceTimer) clearTimeout(debounceTimer);

      console.log(`⚡ [${getTimestamp()}] Phát hiện thay đổi: ${filename}. Sẽ tự động đẩy sau ${debounceMs / 1000}s...`);

      debounceTimer = setTimeout(async () => {
        if (isPushing) return;
        isPushing = true;
        try {
          pushChanges(null, false);
        } finally {
          isPushing = false;
        }
      }, debounceMs);
    });
  } catch (err) {
    console.error(`❌ Không thể khởi động fs.watch recursive:`, err.message);
    console.log(`ℹ️ Đang chuyển sang chế độ Interval (kiểm tra mỗi 30s)...`);
    startIntervalMode(0.5);
  }
}

// Chế độ Interval (định kỳ mỗi N phút)
function startIntervalMode(minutes = 5) {
  const intervalMs = Math.max(10000, minutes * 60 * 1000);
  console.log(`\n==================================================`);
  console.log(`⏰ Chế độ Định Kỳ (Interval Mode) đã bật!`);
  console.log(`⏱️ Kiểm tra và tự động đẩy mỗi: ${minutes} phút (${intervalMs / 1000}s)`);
  console.log(`Nhấn Ctrl + C để dừng.`);
  console.log(`==================================================\n`);

  pushChanges(null, false);

  setInterval(() => {
    pushChanges(null, false);
  }, intervalMs);
}

// Xử lý tham số dòng lệnh
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--watch') || args.includes('-w')) {
    const debounceIdx = args.findIndex(a => a === '--watch' || a === '-w');
    let debounceMs = 15000;
    const nextArg = args[debounceIdx + 1];
    if (nextArg && !isNaN(Number(nextArg))) {
      debounceMs = parseInt(nextArg, 10) * 1000;
    }
    startWatchMode(debounceMs);
    return;
  }

  if (args.includes('--interval') || args.includes('-i')) {
    const intervalIdx = args.findIndex(a => a === '--interval' || a === '-i');
    let minutes = 5;
    const nextArg = args[intervalIdx + 1];
    if (nextArg && !isNaN(Number(nextArg))) {
      minutes = parseFloat(nextArg);
    }
    startIntervalMode(minutes);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Hướng dẫn sử dụng Tự động đẩy Git (Auto-push):
------------------------------------------------
1. Đẩy ngay lập tức:
   npm run push
   hoặc: npm run push "Thêm tính năng mới"

2. Tự động đẩy khi có file thay đổi (Watch mode):
   npm run push:watch
   hoặc: node scripts/autopush.js --watch 15

3. Tự động kiểm tra và đẩy định kỳ mỗi N phút:
   npm run push:interval 5
   hoặc: node scripts/autopush.js --interval 10

4. Click đúp file autopush.bat trên Windows để đẩy ngay 1-click.
`);
    return;
  }

  // Chế độ đẩy ngay 1 lần
  const customMessage = args.filter(a => !a.startsWith('-')).join(' ').trim() || null;
  pushChanges(customMessage, true);
}

main();
