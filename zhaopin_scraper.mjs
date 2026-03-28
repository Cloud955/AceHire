/**
 * zhaopin_scraper.mjs  v3.0  智联招聘 Playwright + 响应拦截 + DOM兜底
 *
 * 策略：
 *   1. playwright-extra + StealthPlugin 规避检测
 *   2. 监听 joblist / getjob / job-list API 响应
 *   3. 滚动3次触发 API 加载
 *   4. DOM 兜底：.joblist-box__item / [class*="jobcard"] 等
 *   5. API + DOM 合并去重，输出 JSON 到 stdout
 */

import { addExtra, chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import fs   from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── 日志 ──────────────────────────────────────────────
const logsDir = path.join(__dirname, 'logs')
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir)
const logDate   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const logFile   = path.join(logsDir, `zhaopin_${logDate}.log`)
const logStream = fs.createWriteStream(logFile, { flags: 'a' })

function ts()        { return new Date().toISOString() }
function writelog(l) { process.stderr.write(l + '\n'); logStream.write(l + '\n') }
function log(msg)    { writelog(`[${ts()}][INFO]  ${msg}`) }
function warn(msg)   { writelog(`[${ts()}][WARN]  ${msg}`) }
function probe(msg)  { writelog(`[${ts()}][PROBE] ${msg}`) }

// ── 读取配置 ──────────────────────────────────────────
const configPath = path.join(__dirname, 'platform_scraper_config.json')
let fileConfig = {}
try { fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) } catch (_) {}

let envConfig = {}
if (process.env.SCRAPER_CONFIG) {
  try { envConfig = JSON.parse(process.env.SCRAPER_CONFIG) } catch (_) {}
}
const config = { ...fileConfig, ...envConfig }

const {
  keywords = ['前端开发'],
  cityCode = '101020100',
  maxJobs  = 25,
} = config
const maxJobsPerKeyword = config.maxJobsPerKeyword || maxJobs || 25

// 城市代码 → 城市名称
const CITY_MAP = {
  '101020100': '上海', '101010100': '北京', '101280100': '广州',
  '101280600': '深圳', '101210100': '杭州', '101270100': '成都',
  '101200100': '武汉', '101190100': '南京', '101110100': '西安',
}
// 城市名称 → 智联城市 ID
const ZHAOPIN_CITY_ID = {
  '上海': '538', '北京': '489', '广州': '763', '深圳': '765',
  '杭州': '653', '成都': '801', '武汉': '736', '南京': '635', '西安': '819',
}
const cityName = CITY_MAP[cityCode] || '上海'
const cityId   = ZHAOPIN_CITY_ID[cityName] || '538'

// ── 读取 Cookie ───────────────────────────────────────
const cookiesPath = path.join(__dirname, './zhaopin_cookies.json')
let fileCookies = []
try {
  fileCookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'))
  probe(`Cookie 读取成功，共 ${fileCookies.length} 条`)
} catch (e) {
  warn(`读取 Cookie 失败：${e.message}，将以未登录状态继续`)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

// Cookie 格式转换（EditThisCookie → Playwright）
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

// 等待验证通过（遇到验证码/robot 页面则轮询）
async function waitForVerification(page) {
  while (true) {
    const url = page.url()
    if (url.includes('captcha') || url.includes('verify') ||
        url.includes('robot') || url.includes('403')) {
      warn(`[验证-智联] 检测到验证页面，请手动通过: ${url}`)
      await sleep(3000)
    } else {
      break
    }
  }
}

// 等待智联职位 API 响应（含超时）
function waitForZhaopinApiResponse(page, keyword, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false

    const timer = setTimeout(() => {
      if (done) return
      done = true
      page.off('response', handler)
      probe(`[API] 等待超时 ${timeoutMs}ms，关键词「${keyword}」`)
      resolve(null)
    }, timeoutMs)

    async function handler(resp) {
      if (done) return
      const url = resp.url()
      if (!url.includes('zhaopin.com')) return
      if (url.includes('.js') || url.includes('.css')) return
      // fe-api.zhaopin.com/c/i/search/positions 是实际的职位列表接口
      const isJobApi = url.includes('/search/positions') ||
                       url.includes('joblist') ||
                       url.includes('getjob') ||
                       url.includes('job-list')
      if (!isJobApi) return

      probe(`[API] 命中！URL: ${url.slice(0, 150)}`)
      try {
        const text = await resp.text()
        probe(`[API] 响应体前200字符: ${text.slice(0, 200)}`)
        const json = JSON.parse(text)
        done = true
        clearTimeout(timer)
        page.off('response', handler)
        resolve(json)
      } catch (e) {
        warn(`[API] 响应读取失败（继续等待）: ${e.message}`)
      }
    }

    page.on('response', handler)
  })
}

// 从智联 API 响应解析职位列表
function parseJobsFromApi(data, keyword) {
  const result =
    data?.data?.results ||
    data?.data?.list ||
    data?.data?.jobList ||
    data?.results ||
    data?.zpData?.jobList ||
    []
  probe(`[API] 解析到 ${result.length} 条原始数据`)

  const jobs = []
  for (const item of result) {
    try {
      const rawId   = item.number || item.jobId || item.id || ''
      const jobTitle = item.name || item.jobName || item.position || ''
      const company  = item.company?.name || item.companyName || ''
      const salary   = item.salary || item.salaryRange || 'Not specified'
      const city     = item.workCity || item.city || cityName
      const desc     = item.summary || item.workDescription || item.description || ''
      const exp      = item.workingExp || item.experience || ''
      const degree   = item.education || item.degree || ''
      const appUrl   = item.positionURL || (rawId ? `https://jobs.zhaopin.com/${rawId}` : '')

      if (!jobTitle) continue
      jobs.push({
        id:              String(rawId) || `zhaopin_api_${Date.now()}_${Math.random()}`,
        job_title:       jobTitle,
        company_name:    company,
        salary_range:    salary,
        location:        city,
        application_url: appUrl,
        description:     desc,
        _job_experience: exp,
        _job_degree:     degree,
        source:          'zhaopin',
        created_at:      new Date().toISOString(),
        _keyword:        keyword,
      })
    } catch (e) {
      warn(`API 职位解析失败: ${e.message}`)
    }
  }
  return jobs
}

// DOM 兜底解析
async function scrapeJobsFromDom(page, keyword) {
  probe('[DOM] 尝试 DOM 兜底...')
  try {
    const jobs = await page.evaluate(({ cityNameArg, keywordArg }) => {
      const results = []
      // 智联招聘职位卡片选择器
      const selectors = [
        '.joblist-box__item',
        '[class*="jobcard"]',
        '.job-list-container li',
        '.list-item',
        '[class*="job-card"]',
      ]
      let items = []
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel)
        if (found.length > 0) { items = found; break }
      }

      items.forEach(el => {
        try {
          const titleEl    = el.querySelector('.jobinfo__name, [class*="title"] a, a[class*="name"], h3 a')
          const companyEl  = el.querySelector('.company-name, [class*="company"] a, .company a')
          const salaryEl   = el.querySelector('.jobinfo__salary, [class*="salary"], .money')
          const locationEl = el.querySelector('.job-address, [class*="location"], .area')
          const linkEl     = el.querySelector('a[href*="zhaopin.com"], a[href*="jobs.zhaopin"]')

          const jobTitle = titleEl?.textContent?.trim() || ''
          if (!jobTitle) return

          const href    = linkEl?.getAttribute('href') || titleEl?.getAttribute('href') || ''
          // 尝试从 URL 中提取数字 ID（智联职位 ID 通常为6位以上数字）
          const idMatch = href.match(/\/(\d{6,})\b/) || href.match(/jobCode=([^&]+)/)
          const jobId   = idMatch ? idMatch[1] : String(Date.now() + Math.random())
          const appUrl  = href.startsWith('http') ? href : (jobId ? `https://jobs.zhaopin.com/${jobId}` : '')

          results.push({
            id:              jobId,
            job_title:       jobTitle,
            company_name:    companyEl?.textContent?.trim() || '',
            salary_range:    salaryEl?.textContent?.trim() || 'Not specified',
            location:        locationEl?.textContent?.trim() || cityNameArg,
            application_url: appUrl,
            description:     '',
            _job_experience: '',
            _job_degree:     '',
            source:          'zhaopin',
            created_at:      new Date().toISOString(),
            _keyword:        keywordArg,
          })
        } catch (_) {}
      })
      return results
    }, { cityNameArg: cityName, keywordArg: keyword })

    probe(`[DOM] 解析到 ${jobs.length} 条职位`)
    return jobs
  } catch (e) {
    warn(`[DOM] 解析失败: ${e.message}`)
    return []
  }
}

// ── 主逻辑 ────────────────────────────────────────────
async function scrapeJobs() {
  probe(`=== 智联招聘爬虫 v3.0 启动 ===`)
  probe(`Node版本: ${process.version}`)
  probe(`关键词: ${keywords.join(', ')} | 城市: ${cityName}(${cityCode},cityId=${cityId}) | 每词上限: ${maxJobsPerKeyword}`)

  const playwrightExtra = addExtra(chromium)
  playwrightExtra.use(StealthPlugin())
  probe('playwright-extra + StealthPlugin 已注册')

  const browser = await playwrightExtra.launch({
    headless: false,
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

  // 注入 Cookie
  if (fileCookies.length > 0) {
    const pwCookies = fileCookies.map(toPlaywrightCookie)
    await context.addCookies(pwCookies)
    probe(`Cookie 已注入，共 ${pwCookies.length} 条`)
  }

  const page = await context.newPage()

  // 屏蔽静态资源
  await page.route('**/*', (route) => {
    const type = route.request().resourceType()
    if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
      route.abort()
    } else {
      route.continue()
    }
  })
  probe('静态资源拦截已启用')

  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) probe(`[导航] ${frame.url()}`)
  })
  page.on('response', resp => {
    const url = resp.url()
    if (url.includes('zhaopin.com') && !url.match(/\.(png|jpg|gif|css|woff|ico|svg|ttf)/)) {
      probe(`[响应] ${resp.status()} ${url.slice(0, 120)}`)
    }
  })
  page.on('crash', () => probe('[PAGE CRASH] 页面崩溃！'))

  // 热身：访问首页激活 Cookie
  probe('导航智联首页...')
  try {
    await page.goto('https://www.zhaopin.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
    probe(`首页完成: ${page.url()} | title: ${await page.title()}`)
  } catch (e) {
    warn(`首页导航异常: ${e.message}`)
  }
  await sleep(2000)
  await waitForVerification(page)

  const allJobs = []
  const seenIds = new Set()

  for (const keyword of keywords) {
    const kwIdx = keywords.indexOf(keyword) + 1
    probe(`\n===== 关键词「${keyword}」(${kwIdx}/${keywords.length}) =====`)

    // 智联搜索 URL（jl=城市ID，kw=关键词，p=页码）
    const searchUrl = `https://sou.zhaopin.com/?jl=${cityId}&kw=${encodeURIComponent(keyword)}&p=1`
    probe(`目标URL: ${searchUrl}`)

    // 先注册监听，再导航
    const apiPromise = waitForZhaopinApiResponse(page, keyword, 20000)

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      probe(`goto 完成: ${page.url()} | title: ${await page.title()}`)
    } catch (e) {
      warn(`goto 异常（继续）: ${e.message}`)
    }

    await waitForVerification(page)

    // 滚动3次触发 API 懒加载
    for (let i = 0; i < 3; i++) {
      await sleep(1000)
      await page.evaluate(() => window.scrollBy(0, 600))
      probe(`[滚动] 第${i + 1}次`)
    }

    probe(`等待 API 响应（最多20s）...`)
    const apiData = await apiPromise
    probe(`API 响应: ${apiData ? '有数据' : '无数据/超时'}`)

    let apiJobs = []
    if (apiData) {
      apiJobs = parseJobsFromApi(apiData, keyword)
      probe(`API 解析到 ${apiJobs.length} 条`)
    }

    // DOM 兜底
    await sleep(1500)
    const domJobs = await scrapeJobsFromDom(page, keyword)

    // 合并：API 优先，DOM 补充新条目
    const combined = [...apiJobs]
    const apiIds = new Set(apiJobs.map(j => j.id))
    for (const j of domJobs) {
      if (!apiIds.has(j.id)) combined.push(j)
    }
    probe(`合并后 ${combined.length} 条（API: ${apiJobs.length}, DOM新增: ${combined.length - apiJobs.length}）`)

    let collected = 0
    for (const job of combined) {
      if (seenIds.has(job.id)) continue
      if (collected >= maxJobsPerKeyword) break
      seenIds.add(job.id)
      allJobs.push(job)
      collected++
      probe(`收录: ${job.job_title} @ ${job.company_name} | ${job.salary_range}`)
    }
    probe(`「${keyword}」完成，新增 ${collected} 个，累计 ${allJobs.length} 个`)

    if (kwIdx < keywords.length) {
      const delay = rand(4000, 6000)
      probe(`等待 ${delay}ms 后继续...`)
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
    probe(`输出 ${jobs.length} 条到 stdout`)
    probe(`日志已保存: ${logFile}`)
    logStream.end()
    process.stdout.write(JSON.stringify(jobs))
  })
  .catch(e => {
    warn(`致命错误: ${e.message}`)
    logStream.end()
    process.stdout.write('[]')
    process.exit(1)
  })
