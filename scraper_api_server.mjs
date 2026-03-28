/**
 * scraper_api_server.mjs - 多平台爬虫 HTTP API 服务
 *
 * 作为 n8n 工作流的本地后端，n8n 通过 HTTP Request 节点调用此服务获取职位数据。
 * 解决了 n8n 中 executeCommand 节点不可用的问题。
 *
 * 启动：node scraper_api_server.mjs
 * 监听：http://localhost:3001
 *
 * API 接口：
 *   POST /scrape/:platform   platform: boss | lagou | liepin | zhaopin
 *   请求体: { keywords, cityCode, maxJobs, headless }
 *   返回: JSON 数组，每项为标准化职位对象
 *
 *   GET  /health        健康检查
 *   GET  /profile       返回 user_profile.json 内容（供 n8n 读取简历，绕过沙箱 fs 限制）
 */

import { createServer } from 'http'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = process.env.SCRAPER_PORT || 3001

const PLATFORM_SCRIPTS = {
  boss:    'boss_zhipin_scraper.mjs',
  lagou:   'lagou_scraper.mjs',
  liepin:  'liepin_scraper.mjs',
  zhaopin: 'zhaopin_scraper.mjs'
}

// ────────────────────────────────────────────────────
// 路由处理
// ────────────────────────────────────────────────────
async function handleRequest(req, res) {
  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    return sendJSON(res, 200, { status: 'ok', platforms: Object.keys(PLATFORM_SCRIPTS) })
  }

  // 用户配置（简历 + 偏好）—— n8n Code 节点沙箱禁用 fs，改由此接口提供
  if (req.method === 'GET' && req.url === '/profile') {
    const profilePath = join(__dirname, 'user_profile.json')
    try {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'))
      return sendJSON(res, 200, profile)
    } catch (e) {
      return sendJSON(res, 500, { error: `读取 user_profile.json 失败: ${e.message}` })
    }
  }

  // 爬取接口
  const match = req.url.match(/^\/scrape\/(\w+)$/)
  if (req.method === 'POST' && match) {
    const platform = match[1]

    if (!PLATFORM_SCRIPTS[platform]) {
      return sendJSON(res, 400, { error: `未知平台: ${platform}`, supported: Object.keys(PLATFORM_SCRIPTS) })
    }

    // 读取请求体
    let body = {}
    try {
      const raw = await readBody(req)
      body = raw ? JSON.parse(raw) : {}
    } catch (_) {}

    const scriptPath = join(__dirname, PLATFORM_SCRIPTS[platform])
    if (!fs.existsSync(scriptPath)) {
      return sendJSON(res, 500, { error: `脚本文件不存在: ${PLATFORM_SCRIPTS[platform]}` })
    }

    console.log(`[${new Date().toLocaleTimeString()}] 开始爬取 ${platform}，配置: ${JSON.stringify(body)}`)

    try {
      const { stdout, stderr } = await execFileAsync('node', [scriptPath], {
        env: {
          ...process.env,
          SCRAPER_CONFIG: JSON.stringify(body)
        },
        maxBuffer: 50 * 1024 * 1024,   // 50 MB
        timeout: 900_000                 // 15 分钟超时（含人工验证等待时间）
      })

      if (stderr) {
        console.warn(`[${platform}] stderr:`, stderr.slice(0, 500))
      }

      let jobs = []
      try {
        jobs = JSON.parse(stdout.trim())
        if (!Array.isArray(jobs)) jobs = []
      } catch (parseErr) {
        console.error(`[${platform}] 解析输出失败:`, parseErr.message)
        // 返回空数组而非报错，让工作流继续运行
      }

      console.log(`[${new Date().toLocaleTimeString()}] ${platform} 爬取完成，获取 ${jobs.length} 个职位`)
      return sendJSON(res, 200, jobs)
    } catch (execErr) {
      console.error(`[${platform}] 执行失败:`, execErr.message)
      return sendJSON(res, 500, { error: `爬虫执行失败: ${execErr.message}` })
    }
  }

  return sendJSON(res, 404, { error: '接口不存在' })
}

// ────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// ────────────────────────────────────────────────────
// 启动服务
// ────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    return res.end()
  }

  try {
    await handleRequest(req, res)
  } catch (e) {
    console.error('未捕获错误:', e)
    sendJSON(res, 500, { error: e.message })
  }
})

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║      多平台招聘爬虫 API 服务已启动               ║
║  地址: http://localhost:${PORT}                    ║
║                                                  ║
║  接口:                                           ║
║    GET  /health           健康检查               ║
║    POST /scrape/boss       BOSS直聘               ║
║    POST /scrape/lagou      拉勾招聘               ║
║    POST /scrape/liepin     猎聘                  ║
║    POST /scrape/zhaopin    智联招聘               ║
║                                                  ║
║  在 n8n 工作流的 HTTP Request 节点中调用此服务   ║
╚══════════════════════════════════════════════════╝
  `)
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭占用进程或修改 SCRAPER_PORT 环境变量`)
  } else {
    console.error('服务器错误:', e)
  }
  process.exit(1)
})
