import { createServer } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'

const exec = promisify(execFile)
const scrypt = promisify(crypto.scrypt)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sitesRoot = join(root, 'data/sites')
const tempRoot = join(root, 'data/tmp')
const adminRoot = join(root, 'admin')
const authFile = join(root, 'data/auth.json')
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024
const adminUsername = process.env.ADMIN_USERNAME || 'admin'
const initialAdminPassword = process.env.ADMIN_PASSWORD || 'change-me'
const sessions = new Map()
const sessionLifetime = 8 * 60 * 60 * 1000

await fs.mkdir(sitesRoot, { recursive: true })
await fs.mkdir(tempRoot, { recursive: true })

async function makePublicReadable(target) {
  const stat = await fs.stat(target)
  await fs.chmod(target, stat.isDirectory() ? 0o755 : 0o644)
  if (!stat.isDirectory()) return
  for (const item of await fs.readdir(target, { withFileTypes: true })) {
    await makePublicReadable(join(target, item.name))
  }
}

async function repairExistingSitePermissions() {
  const entries = await fs.readdir(sitesRoot, { withFileTypes: true })
  for (const entry of entries.filter((item) => item.isDirectory() && /^\d+$/.test(item.name))) {
    await makePublicReadable(join(sitesRoot, entry.name))
  }
}

await repairExistingSitePermissions()

async function hashPassword(value, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(value, salt, 64)
  return { salt, hash: derived.toString('hex') }
}

async function loadAccount() {
  try {
    return JSON.parse(await fs.readFile(authFile, 'utf8'))
  } catch {
    const account = { username: adminUsername, ...(await hashPassword(initialAdminPassword)), createdAt: new Date().toISOString() }
    await fs.writeFile(authFile, JSON.stringify(account, null, 2), { mode: 0o600 })
    return account
  }
}

const account = await loadAccount()

async function saveAccount() {
  await fs.writeFile(authFile, JSON.stringify(account, null, 2), { mode: 0o600 })
  await fs.chmod(authFile, 0o600)
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

async function verifyPassword(value) {
  const derived = await hashPassword(value, account.salt)
  const expected = Buffer.from(account.hash, 'hex')
  const actual = Buffer.from(derived.hash, 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function getSession(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const session = token && sessions.get(token)
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token)
    return null
  }
  session.expiresAt = Date.now() + sessionLifetime
  return { token, ...session }
}

function requireAuth(req, res) {
  if (!getSession(req)) {
    sendJson(res, 401, { error: '请先登录。' })
    return false
  }
  return true
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { username: account.username, expiresAt: Date.now() + sessionLifetime })
  return token
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxUploadBytes + 1024 * 1024) {
        reject(new Error('上传文件超过大小限制。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseMultipart(buffer, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = match?.[1] || match?.[2]
  if (!boundary) throw new Error('缺少 multipart boundary。')
  const marker = Buffer.from(`--${boundary}`)
  const fields = {}
  let file
  let cursor = buffer.indexOf(marker)

  while (cursor >= 0) {
    const headerStart = cursor + marker.length + 2
    if (buffer.slice(cursor + marker.length, cursor + marker.length + 2).toString() === '--') break
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart)
    const next = buffer.indexOf(marker, headerEnd + 4)
    if (headerEnd < 0 || next < 0) break
    const headers = buffer.slice(headerStart, headerEnd).toString()
    const name = headers.match(/name="([^"]+)"/)?.[1]
    const filename = headers.match(/filename="([^"]*)"/)?.[1]
    const value = buffer.slice(headerEnd + 4, next - 2)
    if (name) filename ? file = { filename, data: value } : fields[name] = value.toString()
    cursor = next
  }
  return { fields, file }
}

async function nextId() {
  const entries = await fs.readdir(sitesRoot, { withFileTypes: true })
  const ids = entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => Number(entry.name))
  return String(Math.max(0, ...ids) + 1)
}

async function nextVersion(siteRoot) {
  const entries = await fs.readdir(join(siteRoot, 'versions'), { withFileTypes: true }).catch(() => [])
  const versions = entries.filter((entry) => entry.isDirectory() && /^v\d+$/.test(entry.name)).map((entry) => Number(entry.name.slice(1)))
  return Math.max(0, ...versions) + 1
}

function validateArchive(entriesText) {
  const entries = entriesText.split('\n').map((entry) => entry.trim()).filter(Boolean)
  if (entries.length > 10000) throw new Error('压缩包文件数量过多。')
  for (const raw of entries) {
    const entry = raw.replace(/\\/g, '/')
    if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error('压缩包包含非法路径。')
    if (/\.(php|jsp|asp|aspx|cgi|sh|exe|bat|cmd)$/i.test(entry)) throw new Error('压缩包包含不允许的可执行文件。')
  }
  return entries
}

async function copyContent(source, target) {
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true })
  for (const item of await fs.readdir(source, { withFileTypes: true })) {
    if (item.name !== '.topicweb.json' && item.name !== 'versions') await fs.cp(join(source, item.name), join(target, item.name), { recursive: true })
  }
  await makePublicReadable(target)
}

async function activateVersion(versionRoot, siteRoot) {
  for (const item of await fs.readdir(siteRoot, { withFileTypes: true })) {
    if (item.name !== 'versions' && item.name !== '.topicweb.json') await fs.rm(join(siteRoot, item.name), { recursive: true, force: true })
  }
  for (const item of await fs.readdir(versionRoot, { withFileTypes: true })) {
    await fs.cp(join(versionRoot, item.name), join(siteRoot, item.name), { recursive: true })
  }
  await makePublicReadable(siteRoot)
}

async function readManifest(siteRoot) {
  const manifest = JSON.parse(await fs.readFile(join(siteRoot, '.topicweb.json'), 'utf8'))
  const versionsRoot = join(siteRoot, 'versions')
  let migrated = false
  try { await fs.access(join(versionsRoot, 'v1')) } catch {
    await fs.mkdir(versionsRoot, { recursive: true })
    await copyContent(siteRoot, join(versionsRoot, 'v1'))
    migrated = true
  }
  manifest.status ||= 'published'
  manifest.currentVersion ||= 1
  manifest.versions ||= [{ version: 1, createdAt: manifest.createdAt, fileCount: manifest.fileCount || 0 }]
  if (migrated) await fs.writeFile(join(siteRoot, '.topicweb.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

async function publishZip(file, title, existingId) {
  if (!file?.filename || !/\.zip$/i.test(file.filename)) throw new Error('请选择 ZIP 文件。')
  if (!file.data.length || file.data.length > maxUploadBytes) throw new Error('文件大小超过限制。')
  const token = crypto.randomUUID()
  const zipPath = join(tempRoot, `${token}.zip`)
  const extractedRoot = join(tempRoot, token)
  await fs.writeFile(zipPath, file.data)
  try {
    const listing = await exec('unzip', ['-Z1', zipPath], { maxBuffer: 4 * 1024 * 1024 })
    const entries = validateArchive(listing.stdout)
    await fs.mkdir(extractedRoot)
    await exec('unzip', ['-q', zipPath, '-d', extractedRoot])
    let source = extractedRoot
    const top = await fs.readdir(extractedRoot, { withFileTypes: true })
    if (!top.some((item) => item.isFile() && item.name.toLowerCase() === 'index.html') && top.length === 1 && top[0].isDirectory()) source = join(extractedRoot, top[0].name)
    await fs.access(join(source, 'index.html'))

    const id = existingId || await nextId()
    const siteRoot = join(sitesRoot, id)
    await fs.mkdir(join(siteRoot, 'versions'), { recursive: true })
    // Migrate older sites before allocating the next version. Otherwise the
    // first update of a pre-versioning site would incorrectly become v1.
    let manifest
    try { manifest = await readManifest(siteRoot) } catch {
      manifest = { id, url: `/topicweb/${id}/`, createdAt: new Date().toISOString(), versions: [] }
    }
    const version = await nextVersion(siteRoot)
    const versionRoot = join(siteRoot, 'versions', `v${version}`)
    await copyContent(source, versionRoot)
    await activateVersion(versionRoot, siteRoot)
    manifest.title = String(title || manifest.title || file.filename.replace(/\.zip$/i, '')).trim() || `专题 ${id}`
    manifest.status = 'published'
    manifest.currentVersion = version
    manifest.fileCount = entries.filter((entry) => !entry.endsWith('/')).length
    manifest.versions = [...(manifest.versions || []), { version, createdAt: new Date().toISOString(), fileCount: manifest.fileCount }]
    manifest.updatedAt = new Date().toISOString()
    await fs.writeFile(join(siteRoot, '.topicweb.json'), JSON.stringify(manifest, null, 2))
    await makePublicReadable(siteRoot)
    return manifest
  } finally {
    await fs.rm(zipPath, { force: true })
    await fs.rm(extractedRoot, { recursive: true, force: true })
  }
}

async function listTopics() {
  const entries = await fs.readdir(sitesRoot, { withFileTypes: true })
  const result = []
  for (const entry of entries.filter((item) => item.isDirectory() && /^\d+$/.test(item.name))) {
    try { result.push(await readManifest(join(sitesRoot, entry.name))) } catch {}
  }
  return result.sort((a, b) => Number(b.id) - Number(a.id))
}

async function setStatus(id, status) {
  const siteRoot = join(sitesRoot, id)
  const manifest = await readManifest(siteRoot)
  manifest.status = status
  if (status === 'published') await activateVersion(join(siteRoot, 'versions', `v${manifest.currentVersion}`), siteRoot)
  else for (const item of await fs.readdir(siteRoot, { withFileTypes: true })) if (item.name !== 'versions' && item.name !== '.topicweb.json') await fs.rm(join(siteRoot, item.name), { recursive: true, force: true })
  manifest.updatedAt = new Date().toISOString()
  await fs.writeFile(join(siteRoot, '.topicweb.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

function serveAdmin(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname
  const file = pathname === '/manage' || pathname === '/manage/' ? 'index.html' : pathname.replace(/^\/manage\/?/, '')
  const path = resolve(adminRoot, file || 'index.html')
  if (relative(adminRoot, path).startsWith('..')) return sendJson(res, 404, { error: 'Not found' })
  createReadStream(path).on('error', () => sendJson(res, 404, { error: 'Not found' })).pipe(res)
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    if (pathname.startsWith('/manage')) return serveAdmin(req, res)
    if (pathname === '/api/login' && req.method === 'POST') {
      const data = JSON.parse((await readBody(req)).toString() || '{}')
      if (data.username !== account.username || !(await verifyPassword(String(data.password || '')))) {
        return sendJson(res, 401, { error: '账号或密码错误。' })
      }
      return sendJson(res, 200, { token: createSession(), username: account.username })
    }
    if (!requireAuth(req, res)) return
    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
      if (token) sessions.delete(token)
      return sendJson(res, 200, { data: { ok: true } })
    }
    if (pathname === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, { data: { username: account.username } })
    }
    if (pathname === '/api/account/password' && req.method === 'POST') {
      const data = JSON.parse((await readBody(req)).toString() || '{}')
      if (!(await verifyPassword(String(data.currentPassword || '')))) {
        return sendJson(res, 400, { error: '当前密码错误。' })
      }
      const newPassword = String(data.newPassword || '')
      if (newPassword.length < 8) return sendJson(res, 400, { error: '新密码至少需要 8 位。' })
      Object.assign(account, await hashPassword(newPassword))
      await saveAccount()
      sessions.clear()
      return sendJson(res, 200, { data: { ok: true } })
    }
    if (pathname === '/api/topics' && req.method === 'GET') return sendJson(res, 200, { data: await listTopics() })
    if (pathname === '/api/topics/upload' && req.method === 'POST') {
      const parsed = parseMultipart(await readBody(req), req.headers['content-type'] || '')
      return sendJson(res, 201, { data: await publishZip(parsed.file, parsed.fields.title) })
    }
    const match = pathname.match(/^\/api\/topics\/(\d+)(?:\/(upload|publish|offline|versions))?$/)
    if (!match) return sendJson(res, 404, { error: 'Not found' })
    const id = match[1]; const action = match[2]
    if (!action && req.method === 'DELETE') { await fs.rm(join(sitesRoot, id), { recursive: true, force: true }); return sendJson(res, 200, { data: { ok: true } }) }
    if (action === 'upload' && req.method === 'POST') { const parsed = parseMultipart(await readBody(req), req.headers['content-type'] || ''); return sendJson(res, 201, { data: await publishZip(parsed.file, parsed.fields.title, id) }) }
    if (action === 'publish' && req.method === 'POST') return sendJson(res, 200, { data: await setStatus(id, 'published') })
    if (action === 'offline' && req.method === 'POST') return sendJson(res, 200, { data: await setStatus(id, 'offline') })
    if (action === 'versions' && req.method === 'GET') return sendJson(res, 200, { data: (await readManifest(join(sitesRoot, id))).versions || [] })
    if (action === 'versions' && req.method === 'POST') {
      const version = Number(url.searchParams.get('version')); const siteRoot = join(sitesRoot, id); const manifest = await readManifest(siteRoot)
      if (!Number.isInteger(version) || !manifest.versions?.some((item) => item.version === version)) throw new Error('版本不存在。')
      await activateVersion(join(siteRoot, 'versions', `v${version}`), siteRoot); manifest.currentVersion = version; manifest.status = 'published'; manifest.updatedAt = new Date().toISOString()
      await fs.writeFile(join(siteRoot, '.topicweb.json'), JSON.stringify(manifest, null, 2)); return sendJson(res, 200, { data: manifest })
    }
    return sendJson(res, 405, { error: 'Method not allowed' })
  } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : '请求失败。' }) }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('topicweb api ready'))
