const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const plist = require('plist');

const app = express();
const PORT = process.env.PORT || 3000;
const ZSIGN = process.env.ZSIGN_PATH || '/usr/local/bin/zsign';
const SITE_PASSWORD = process.env.SITE_PASSWORD;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
).replace(/\/+$/, '');

if (!SITE_PASSWORD || SITE_PASSWORD.length < 16) {
  console.error('Set SITE_PASSWORD to a random value of at least 16 characters');
  process.exit(1);
}
if (!PUBLIC_BASE_URL) {
  console.error('Set PUBLIC_BASE_URL to your public HTTPS Railway domain');
  process.exit(1);
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/ota/')) return next();
  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from('ipa:' + SITE_PASSWORD).toString('base64');
  if (header !== expected) {
    res.set('WWW-Authenticate', 'Basic realm="IPA Signer"');
    return res.status(401).send('Authentication required');
  }
  next();
});

app.use(rateLimit({ windowMs: 60000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 600 * 1024 * 1024, files: 3, fields: 5 }
});
const otaFiles = new Map();
const OTA_TTL_MS = 2 * 60 * 60 * 1000;

function removeTree(dir) {
  if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
function cleanUpload(file) {
  if (file?.path) try { fs.rmSync(file.path, { force: true }); } catch {}
}
function run(command, args, timeoutMs = 12 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    const append = (old, chunk) => Buffer.concat([old, chunk]).subarray(-20000);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      else reject(new Error((stderr.toString() || stdout.toString() || `${command} exit ${code}`).slice(-3000)));
    });
  });
}

// Stream binary stdout directly to disk. Never convert a binary plist to UTF-8 text.
function runToFile(command, args, outputPath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = fs.createWriteStream(outputPath, { mode: 0o600 });
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.pipe(output);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-5000); });
    output.on('error', error => { child.kill('SIGKILL'); finish(error); });
    child.on('error', error => finish(error));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} timed out`));
    }, timeoutMs);
    child.on('close', code => {
      output.end(() => {
        if (code === 0) finish();
        else finish(new Error((stderr || `${command} exit ${code}`).slice(-3000)));
      });
    });
  });
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[<>&'"]/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[char]));
}

async function readAppInfo(ipaPath, workDir) {
  const listing = await run('unzip', ['-Z1', ipaPath], 60000);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  const infoPath = entries.find(name => /^Payload\/[^/]+\.app\/Info\.plist$/.test(name));
  if (!infoPath) {
    const apps = entries.filter(name => /^Payload\/[^/]+\.app\//.test(name));
    throw new Error(apps.length
      ? '앱 폴더는 있지만 Info.plist를 찾지 못했습니다.'
      : 'IPA 내부에서 Payload/*.app/Info.plist를 찾지 못했습니다. 올바른 iOS IPA인지 확인해 주세요.');
  }

  const binaryPlistPath = path.join(workDir, 'Info.binary.plist');
  const xmlPlistPath = path.join(workDir, 'Info.xml');
  await runToFile('unzip', ['-p', ipaPath, infoPath], binaryPlistPath, 60000);

  // plistutil converts both Apple's binary plist and XML plist to XML.
  await run('plistutil', ['-i', binaryPlistPath, '-o', xmlPlistPath, '-f', 'xml'], 60000);
  const info = plist.parse(fs.readFileSync(xmlPlistPath, 'utf8'));
  const bundleId = info.CFBundleIdentifier;

  if (typeof bundleId !== 'string' || !bundleId.trim()) {
    throw new Error('Info.plist는 읽었지만 CFBundleIdentifier 키가 없거나 비어 있습니다.');
  }
  return {
    bundleId: bundleId.trim(),
    title: info.CFBundleDisplayName || info.CFBundleName || bundleId,
    version: info.CFBundleShortVersionString || info.CFBundleVersion || '1.0'
  };
}

app.get('/health', (req, res) => {
  const ok = fs.existsSync(ZSIGN);
  res.status(ok ? 200 : 503).json({ ok, signingEngine: ok ? 'present' : 'missing' });
});

app.get('/ota/manifest/:token.plist', (req, res) => {
  const item = otaFiles.get(req.params.token);
  if (!item || item.expiresAt < Date.now()) return res.status(404).send('Install link expired');
  const ipaUrl = `${PUBLIC_BASE_URL}/ota/ipa/${req.params.token}.ipa`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${xmlEscape(ipaUrl)}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${xmlEscape(item.bundleId)}</string><key>bundle-version</key><string>${xmlEscape(item.version)}</string><key>kind</key><string>software</string><key>title</key><string>${xmlEscape(item.title)}</string></dict></array></dict></plist>`;
  res.type('application/xml').send(manifest);
});

app.get('/ota/ipa/:token.ipa', (req, res) => {
  const item = otaFiles.get(req.params.token);
  if (!item || item.expiresAt < Date.now()) return res.status(404).send('Install link expired');
  res.download(item.ipaPath, `${item.title.replace(/[^a-z0-9._-]/gi, '_')}.ipa`);
});

app.post('/api/sign', upload.fields([
  { name: 'ipa', maxCount: 1 },
  { name: 'p12', maxCount: 1 },
  { name: 'mobileprovision', maxCount: 1 }
]), async (req, res) => {
  const ipa = req.files?.ipa?.[0];
  const p12 = req.files?.p12?.[0];
  const profile = req.files?.mobileprovision?.[0];
  const password = req.body?.password || '';
  let workDir;
  try {
    if (!ipa || !p12 || !profile) throw new Error('IPA, P12, MobileProvision 파일을 모두 선택해 주세요.');
    if (!password) throw new Error('P12 비밀번호를 입력해 주세요.');
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-signer-'));
    fs.chmodSync(workDir, 0o700);
    const inputIpa = path.join(workDir, 'input.ipa');
    const cert = path.join(workDir, 'certificate.p12');
    const mobileProvision = path.join(workDir, 'profile.mobileprovision');
    const signedIpa = path.join(workDir, 'signed.ipa');
    fs.copyFileSync(ipa.path, inputIpa);
    fs.copyFileSync(p12.path, cert);
    fs.copyFileSync(profile.path, mobileProvision);

    await run(ZSIGN, ['-k', cert, '-p', password, '-m', mobileProvision, '-o', signedIpa, inputIpa]);
    if (!fs.existsSync(signedIpa) || fs.statSync(signedIpa).size < 1000) {
      throw new Error('zsign이 유효한 출력 IPA를 생성하지 않았습니다.');
    }

    const metadata = await readAppInfo(signedIpa, workDir);
    const token = crypto.randomBytes(32).toString('hex');
    const savedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-ota-'));
    fs.chmodSync(savedDir, 0o700);
    const savedIpa = path.join(savedDir, 'signed.ipa');
    fs.copyFileSync(signedIpa, savedIpa);
    otaFiles.set(token, { ...metadata, ipaPath: savedIpa, savedDir, expiresAt: Date.now() + OTA_TTL_MS });

    const manifestUrl = `${PUBLIC_BASE_URL}/ota/manifest/${token}.plist`;
    const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
    res.json({
      ok: true,
      title: metadata.title,
      bundleId: metadata.bundleId,
      version: metadata.version,
      installUrl,
      downloadUrl: `${PUBLIC_BASE_URL}/ota/ipa/${token}.ipa`,
      expiresInSeconds: OTA_TTL_MS / 1000
    });
  } catch (error) {
    if (!res.headersSent) res.status(400).json({ error: error.message || 'Signing failed' });
  } finally {
    cleanUpload(ipa);
    cleanUpload(p12);
    cleanUpload(profile);
    removeTree(workDir);
  }
});

setInterval(() => {
  for (const [token, item] of otaFiles) {
    if (item.expiresAt <= Date.now()) {
      removeTree(item.savedDir);
      otaFiles.delete(token);
    }
  }
}, 10 * 60 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => console.log(`IPA Signer listening on ${PORT}`));
