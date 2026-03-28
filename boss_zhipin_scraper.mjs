/**
 * boss_zhipin_scraper.mjs  v6.4  Playwright + joblist.json 响应拦截 + detail.json 岗位描述
 *
 * 核心策略：
 *   1. Playwright + playwright-extra + stealth（规避 zpAegis CDP 检测）
 *   2. 监听 joblist.json 响应，数据一到立刻提取，不再 DOM 滚动
 *   3. 避免 ERR_INSUFFICIENT_RESOURCES（过度滚动导致资源耗尽 → about:blank）
 */

import { addExtra, chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import fs   from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── 日志文件 ──────────────────────────────────────────
const logsDir = path.join(__dirname, 'logs')
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir)
const logDate = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const logFile = path.join(logsDir, `boss_${logDate}.log`)
const logStream = fs.createWriteStream(logFile, { flags: 'a' })

function ts() { return new Date().toISOString() }
function writelog(line) {
  process.stderr.write(line + '\n')
  logStream.write(line + '\n')
}
function log(msg)   { writelog(`[${ts()}][INFO]  ${msg}`) }
function warn(msg)  { writelog(`[${ts()}][WARN]  ${msg}`) }
function probe(msg) { writelog(`[${ts()}][PROBE] ${msg}`) }

function fatal(msg) {
  writelog(`[${ts()}][ERROR] ${msg}`)
  logStream.end()
  process.stderr.write(JSON.stringify({ error: msg }) + '\n')
  process.exit(1)
}

// ── 读取配置 ──────────────────────────────────────────
const configPath = path.join(__dirname, 'boss_zhipin_config.json')
let fileConfig = {}
try { fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) } catch (_) {}

let envConfig = {}
if (process.env.SCRAPER_CONFIG) {
  try { envConfig = JSON.parse(process.env.SCRAPER_CONFIG) } catch (_) {}
}
const config = { ...fileConfig, ...envConfig }

const {
  keywords          = ['产品经理'],
  cityCode          = '101010100',
  maxJobsPerKeyword = 20,
  cookiesFile       = './boss_cookies.json',
} = config

const headless = false

// ── 读取 Cookie ───────────────────────────────────────
const cookiesPath = path.join(__dirname, cookiesFile)
let fileCookies = []
try {
  fileCookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'))
  probe(`Cookie 文件读取成功，共 ${fileCookies.length} 条`)
  probe(`Cookie 名称列表: ${fileCookies.map(c => c.name).join(', ')}`)
} catch (e) {
  fatal(`读取 Cookie 失败：${e.message}`)
}
if (!Array.isArray(fileCookies) || fileCookies.length === 0) {
  fatal('boss_cookies.json 为空')
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

// Cookie 格式转换
function toPlaywrightCookie(c) {
  const cookie = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' }
  if (c.expires && c.expires > 0) cookie.expires = Math.floor(c.expires)
  if (c.httpOnly != null) cookie.httpOnly = !!c.httpOnly
  if (c.secure   != null) cookie.secure   = !!c.secure
  if (c.sameSite) {
    const map = { unspecified: 'None', no_restriction: 'None', lax: 'Lax', strict: 'Strict' }
    cookie.sameSite = map[c.sameSite.toLowerCase()] || 'None'
  }
  return cookie
}

// ── 从 joblist.json API 响应解析职位 ─────────────────
function parseJobsFromApiResponse(data, keyword) {
  // zpGeek joblist API 结构：data.zpData.jobList[]
  const jobList = data?.zpData?.jobList || data?.data?.jobList || []
  probe(`joblist API 返回 ${jobList.length} 条原始数据`)

  const jobs = []
  for (const item of jobList) {
    try {
      const jobId      = item.encryptJobId || item.jobId || ''
      const securityId = item.securityId || ''
      const appUrl     = jobId ? `https://www.zhipin.com/job_detail/${jobId}.html` : ''

      // 薪资：salaryDesc（"15-25K·14薪"）
      const salaryRaw = item.salaryDesc || item.salary || 'Not specified'

      // 标签：jobLabels（["北京", "3-5年", "本科"]）
      const labels = item.jobLabels || []

      // 技能：skills（["Python","数据分析"]）
      const skills = item.skills || item.jobExperience || []

      // 公司标签：brandIndustry, brandScaleName
      const industry = item.brandIndustry || item.industryName || 'Not specified'

      jobs.push({
        id: jobId || `api_${Date.now()}_${Math.random()}`,
        _security_id:    securityId,
        company_name:    item.brandName || item.companyName || '未知公司',
        job_title:       item.jobName || '未知职位',
        application_url: appUrl,
        location:        labels[0] || item.cityName || '',
        description:     skills.length ? `技能要求：${skills.join('、')}` : (item.jobExperience || ''),
        industry,
        flexibility:     '',
        salary_range:    salaryRaw,
        status: 'new', source: 'boss_zhipin', created_at: new Date().toISOString(),
        _job_experience: labels[1] || item.jobExperience || '',
        _job_degree:     labels[2] || item.jobDegree || '',
        _company_scale:  item.brandScaleName || '',
        _boss_name:      item.bossName || '',
        _boss_active:    item.activeTimeDesc || '',
        _skills:         Array.isArray(skills) ? skills : [],
        _keyword:        keyword,
      })
    } catch (e) {
      warn(`API 职位解析失败: ${e.message}`)
    }
  }
  return jobs
}

// ── 通过 detail.json 获取完整岗位描述 ────────────────
// 策略：拦截浏览器自动发出的 detail 请求（不主动 fetch，避免触发频率限制）
// 搜索页加载时会自动预加载第一个职位的 detail；
// 通过模拟点击列表项触发其余职位的 detail 请求
async function collectDetailsByClicking(page, jobs) {
  const detailCache = new Map()  // securityId → postDescription

  // 注册监听器，缓存所有 detail 响应
  async function detailHandler(resp) {
    const url = resp.url()
    if (!url.includes('zpgeek/job/detail.json')) return
    try {
      const json = await resp.json()
      if (json?.code !== 0) return
      const jobInfo = json?.zpData?.jobInfo
      if (!jobInfo?.postDescription) return
      // 从 URL 提取 securityId
      const m = url.match(/[?&]securityId=([^&]+)/)
      if (m) detailCache.set(decodeURIComponent(m[1]), String(jobInfo.postDescription).trim())
    } catch (_) {}
  }
  page.on('response', detailHandler)

  // 等待职位列表 DOM 渲染完成（API 响应到达后 DOM 可能还未更新）
  try {
    await page.waitForSelector('.rec-job-list li.job-card-box, .job-list-box li.job-card-box', { timeout: 5000 })
  } catch (_) {
    // 超时：dump 页面实际结构帮助调试
    try {
      const domSnap = await page.evaluate(() => {
        const box = document.querySelector('[class*="job-list"]') || document.querySelector('ul') || document.body
        return box ? box.className + ' | children: ' + Array.from(box.children).slice(0, 3).map(el => el.tagName + '.' + el.className).join(', ') : 'not found'
      })
      probe(`[collectDetails] DOM超时，job-list区域: ${domSnap}`)
    } catch (_2) {}
    probe('[collectDetails] 等待职位卡片DOM超时，跳过点击')
    page.off('response', detailHandler)
    return detailCache
  }

  // 只选真实职位卡片（job-card-box），跳过广告/空位 li
  const cards = page.locator('.rec-job-list li.job-card-box, .job-list-box li.job-card-box')
  const cardCount = await cards.count()
  probe(`[collectDetails] 找到 ${cardCount} 个职位卡片，职位 ${jobs.length} 个`)

  for (let i = 0; i < Math.min(jobs.length, cardCount); i++) {
    if (detailCache.has(jobs[i]._security_id)) continue  // 已缓存，跳过
    try {
      await cards.nth(i).click({ timeout: 3000 })
      await sleep(rand(800, 1400))  // 等待 detail 响应
    } catch (e) {
      probe(`[collectDetails] 第 ${i + 1} 个卡片点击失败: ${e.message.slice(0, 80)}`)
    }
  }

  page.off('response', detailHandler)
  return detailCache
}

// ── 等待 joblist.json 响应（带超时）────────────────────
function waitForJoblistResponse(page, keyword, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false

    const timer = setTimeout(() => {
      if (done) return
      done = true
      page.off('response', handler)
      probe(`[joblist] 等待超时 ${timeoutMs}ms，关键词「${keyword}」`)
      resolve(null)
    }, timeoutMs)

    async function handler(resp) {
      if (done) return
      const url = resp.url()
      if (!url.includes('joblist.json')) return

      probe(`[joblist] 命中！URL: ${url.slice(0, 150)}`)

      try {
        const text = await resp.text()
        probe(`[joblist] 响应体前200字符: ${text.slice(0, 200)}`)
        const json = JSON.parse(text)
        probe(`[joblist] code=${json.code} message=${json.message}`)
        // 成功读取后才标记完成并解绑
        done = true
        clearTimeout(timer)
        page.off('response', handler)
        resolve(json)
      } catch (e) {
        // 读取失败（body 已释放），继续等待下一个 joblist.json
        warn(`[joblist] 响应体读取失败（忽略，继续等待）: ${e.message}`)
      }
    }

    page.on('response', handler)
  })
}

// ── 主逻辑 ────────────────────────────────────────────
async function scrapeJobs() {
  probe(`=== 启动 v6.4 ===`)
  probe(`Node版本: ${process.version}`)
  probe(`关键词: ${keywords.join(', ')} | 城市: ${cityCode} | 每词上限: ${maxJobsPerKeyword}`)
  probe(`日志文件: ${logFile}`)
  probe(`策略: Playwright + joblist.json 响应拦截（不做DOM滚动）`)

  const playwrightExtra = addExtra(chromium)
  playwrightExtra.use(StealthPlugin())
  probe('playwright-extra + StealthPlugin 已注册')

  // ── 浏览器启动 ────────────────────────────────────
  probe('开始启动浏览器...')
  const browser = await playwrightExtra.launch({
    headless,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--window-size=1440,900',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio',
    ],
  })
  probe('浏览器已启动')

  // ── 创建 Context ──────────────────────────────────
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'accept-language':    'zh-CN,zh;q=0.9',
      'sec-ch-ua':          '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
      'sec-ch-ua-mobile':   '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  })
  probe('BrowserContext 已创建')

  // 反检测脚本
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol
    window.navigator.chrome = { runtime: {} }
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3] })
  })
  probe('反检测 initScript 已注入')

  // Cookie 注入
  const pwCookies = fileCookies.map(toPlaywrightCookie)
  await context.addCookies(pwCookies)
  probe(`Cookie 已注入 context，共 ${pwCookies.length} 条`)

  // ── 打开页面 ──────────────────────────────────────
  const page = await context.newPage()
  probe('新页面已创建')

  // 监听主框架跳转
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      probe(`[导航事件] 主框架跳转 → ${frame.url()}`)
    }
  })

  // 监听控制台错误
  page.on('console', msg => {
    if (msg.type() === 'error') probe(`[浏览器Console ERROR] ${msg.text()}`)
  })

  // 监听页面崩溃
  page.on('crash', () => probe('[PAGE CRASH] 页面崩溃！'))

  // 监听所有关键响应（诊断用，不含静态资源）
  page.on('response', resp => {
    const url = resp.url()
    const status = resp.status()
    if (url.includes('zhipin.com') && !url.match(/\.(png|jpg|gif|css|woff|ico|svg|ttf)/)) {
      probe(`[响应] ${status} ${url.slice(0, 120)}`)
    }
  })

  // ── 首页导航（热身，激活 Cookie）────────────────────
  probe('开始导航首页 https://www.zhipin.com ...')
  try {
    await page.goto('https://www.zhipin.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
    probe(`首页导航完成，当前URL: ${page.url()}`)
    probe(`首页 title: ${await page.title()}`)
  } catch (e) {
    warn(`首页导航异常: ${e.message}`)
    probe(`异常后当前URL: ${page.url()}`)
  }

  await sleep(2000)
  probe(`首页停留2s后URL: ${page.url()}`)
  const loginBtnCount   = await page.locator('.nav-login-btn, [ka="header-login"]').count()
  const userAvatarCount = await page.locator('.nav-figure, .user-nav').count()
  probe(`登录按钮数量: ${loginBtnCount}（>0说明未登录，Cookie失效）`)
  probe(`用户头像/导航数量: ${userAvatarCount}（>0说明已登录）`)

  await sleep(6000)

  const allJobs = []
  const seenIds = new Set()

  for (const keyword of keywords) {
    const kwIdx = keywords.indexOf(keyword) + 1
    probe(`\n===== 关键词 「${keyword}」 (${kwIdx}/${keywords.length}) =====`)

    const searchUrl = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}&city=${cityCode}`
    probe(`目标URL: ${searchUrl}`)

    // 注册 joblist.json 监听器（先注册，再导航，避免竞争）
    const joblistPromise = waitForJoblistResponse(page, keyword, 20000)

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      probe(`goto 完成，当前URL: ${page.url()}`)
      probe(`页面 title: ${await page.title()}`)
    } catch (e) {
      probe(`goto 异常（忽略，继续等待joblist）: ${e.message}`)
      probe(`异常后当前URL: ${page.url()}`)
    }

    // 等待 joblist.json 响应（20s超时）
    probe(`等待 joblist.json 响应（最多20s）...`)
    const apiData = await joblistPromise

    probe(`导航后当前URL: ${page.url()}`)

    if (page.url() === 'about:blank' || page.url() === '') {
      probe(`⚠️ 已跳转 about:blank，zpAegis 拦截，跳过此关键词`)
      continue
    }

    if (!apiData) {
      probe(`「${keyword}」未收到 joblist.json 数据，跳过`)
      continue
    }

    if (apiData.code !== 0) {
      probe(`「${keyword}」joblist API code=${apiData.code}，跳过（code=37通常为安全校验）`)
      continue
    }

    // 从 API 响应解析职位（不做DOM操作，避免触发资源耗尽）
    const jobs = parseJobsFromApiResponse(apiData, keyword)
    const jobsToCollect = jobs.filter(j => j.id && !seenIds.has(j.id)).slice(0, maxJobsPerKeyword)

    // 通过点击列表卡片触发 detail 响应，批量收集 JD（不主动 fetch）
    probe(`开始点击列表收集 JD，共 ${jobsToCollect.length} 个职位...`)
    const detailCache = await collectDetailsByClicking(page, jobsToCollect)
    probe(`JD 缓存命中 ${detailCache.size} / ${jobsToCollect.length} 个`)

    let collected = 0
    for (const job of jobsToCollect) {
      seenIds.add(job.id)
      const jd = detailCache.get(job._security_id) || ''
      if (jd) {
        job.description = jd
        probe(`[JD] ${job.job_title} @ ${job.company_name} — ${jd.length}字`)
      } else {
        probe(`[JD] ${job.job_title} @ ${job.company_name} — 未获取到JD，使用技能标签`)
      }
      allJobs.push(job)
      collected++
      probe(`收录: ${job.job_title} @ ${job.company_name} | ${job.salary_range}`)
    }

    probe(`「${keyword}」完成，新增 ${collected} 个，累计 ${allJobs.length} 个`)

    if (kwIdx < keywords.length) {
      const delay = rand(4000, 6000)
      probe(`等待 ${delay}ms 后继续下一关键词...`)
      await sleep(delay)
    }
  }

  probe(`=== 全部完成，共 ${allJobs.length} 个职位，关闭浏览器 ===`)
  await context.close()
  await browser.close()
  return allJobs
}

scrapeJobs()
  .then(jobs => {
    probe(`输出 ${jobs.length} 条职位到 stdout`)
    probe(`日志已保存: ${logFile}`)
    logStream.end()
    process.stdout.write(JSON.stringify(jobs))
  })
  .catch(e => fatal(e.message))
