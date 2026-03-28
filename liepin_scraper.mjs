/**
 * liepin_scraper.mjs  v3.0  猎聘招聘 Playwright + 响应拦截 + DOM兜底
 *
 * 策略：
 *   1. playwright-extra + StealthPlugin 规避检测
 *   2. 监听 getJobCard / getjobscard / searchfront / /api/com.liepin. API 响应
 *   3. 滚动3次触发 API 加载
 *   4. DOM 兜底：.job-card-pc-container / .job-list-box 等
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
const logFile   = path.join(logsDir, `liepin_${logDate}.log`)
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
const cityName = CITY_MAP[cityCode] || '上海'

// ── 读取 Cookie ───────────────────────────────────────
const cookiesPath = path.join(__dirname, './liepin_cookies.json')
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
      warn(`[验证-猎聘] 检测到验证页面，请手动通过: ${url}`)
      await sleep(3000)
    } else {
      break
    }
  }
}

// 等待猎聘职位 API 响应（含超时）
function waitForLiepinApiResponse(page, keyword, timeoutMs = 20000) {
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
      if (!url.includes('liepin.com')) return
      // 真实职位列表接口：com.liepin.searchfront4c.pc-search-job
      const isJobApi = (url.includes('pc-search-job') && !url.includes('cond-init')) ||
                       url.includes('getJobCard') ||
                       url.includes('getjobscard')
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

// 从猎聘 API 响应解析职位列表
function parseJobsFromApi(data, keyword) {
  const result =
    data?.data?.result?.jobCardList ||
    data?.data?.jobList ||
    data?.result?.jobCardList ||
    []
  probe(`[API] 解析到 ${result.length} 条原始数据`)

  const jobs = []
  for (const item of result) {
    try {
      const jobId   = item.jobId || item.id || item.encryptJobId || ''
      const jobTitle = item.jobTitle || item.title || item.name || ''
      const company  = item.companyName || item.company || ''
      const salary   = item.salary || item.salaryRange || 'Not specified'
      const city     = item.cityName || item.city || cityName
      const desc     = item.requirement || item.description || item.jobDesc || ''
      const exp      = item.workingExp || item.workExp || ''
      const degree   = item.education || item.edu || ''
      const appUrl   = jobId ? `https://www.liepin.com/job/${jobId}.shtml` : ''

      if (!jobTitle) continue
      jobs.push({
        id:              String(jobId) || `liepin_api_${Date.now()}_${Math.random()}`,
        job_title:       jobTitle,
        company_name:    company,
        salary_range:    salary,
        location:        city,
        application_url: appUrl,
        description:     desc,
        _job_experience: exp,
        _job_degree:     degree,
        source:          'liepin',
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
      // 猎聘职位卡片选择器（参考 Locators.java job-card-pc-container）
      const items = document.querySelectorAll(
        '.job-card-pc-container, .job-list-box .job-card, [class*="job-card-pc"], .sojob-item'
      )
      items.forEach(el => {
        try {
          const titleEl    = el.querySelector('.job-title-box, .job-name, h3 a, [class*="title"] a, a[class*="job"]')
          const companyEl  = el.querySelector('.company-name, [class*="company-name"], .company a')
          const salaryEl   = el.querySelector('.job-salary, .salary, [class*="salary"]')
          const locationEl = el.querySelector('.job-city, .location, [class*="city"]')
          const linkEl     = el.querySelector('a[href*="/job/"]')

          const jobTitle = titleEl?.textContent?.trim() || ''
          if (!jobTitle) return

          const href    = linkEl?.getAttribute('href') || titleEl?.getAttribute('href') || ''
          const idMatch = href.match(/\/job\/(\d+)/)
          const jobId   = idMatch ? idMatch[1] : ''
          const appUrl  = jobId
            ? `https://www.liepin.com/job/${jobId}.shtml`
            : (href.startsWith('http') ? href : '')

          results.push({
            id:              jobId || `dom_${Date.now()}_${Math.random()}`,
            job_title:       jobTitle,
            company_name:    companyEl?.textContent?.trim() || '',
            salary_range:    salaryEl?.textContent?.trim() || 'Not specified',
            location:        locationEl?.textContent?.trim() || cityNameArg,
            application_url: appUrl,
            description:     '',
            _job_experience: '',
            _job_degree:     '',
            source:          'liepin',
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
  probe(`=== 猎聘爬虫 v3.0 启动 ===`)
  probe(`Node版本: ${process.version}`)
  probe(`关键词: ${keywords.join(', ')} | 城市: ${cityName}(${cityCode}) | 每词上限: ${maxJobsPerKeyword}`)

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

  // 注入 Cookie（跳过动态反爬 token，让服务器重新颁发）
  const DYNAMIC_COOKIES = ['acw_tc', 'acw_sc__v3', 'acw_sc__v2', '_csrf']
  if (fileCookies.length > 0) {
    const pwCookies = fileCookies
      .filter(c => !DYNAMIC_COOKIES.includes(c.name))
      .map(toPlaywrightCookie)
    await context.addCookies(pwCookies)
    probe(`Cookie 已注入，共 ${pwCookies.length} 条（已跳过动态token）`)
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
    if (url.includes('liepin.com') && !url.match(/\.(png|jpg|gif|css|woff|ico|svg|ttf)/)) {
      probe(`[响应] ${resp.status()} ${url.slice(0, 120)}`)
    }
  })
  page.on('crash', () => probe('[PAGE CRASH] 页面崩溃！'))

  // 热身：访问首页激活 Cookie
  probe('导航猎聘首页...')
  try {
    await page.goto('https://www.liepin.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
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

    // 猎聘搜索 URL（dq=城市名，key=关键词，currentPage=0）
    const searchUrl = `https://www.liepin.com/zhaopin/?dq=${encodeURIComponent(cityName)}&key=${encodeURIComponent(keyword)}&currentPage=0`
    probe(`目标URL: ${searchUrl}`)

    // 先注册监听，再导航
    const apiPromise = waitForLiepinApiResponse(page, keyword, 20000)

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
