# AceHire — 多平台智能求职助手

每日自动从 **BOSS直聘 / 拉勾 / 猎聘 / 智联招聘** 采集岗位，由大模型评分并生成简历修改建议，结果同步到**飞书多维表格**。

```
定时触发（工作日 8:00）
    ↓
本地爬虫服务采集 4 个平台的职位
    ↓
关键词过滤 + 去重
    ↓
大模型匹配评分（0–100）+ 简历修改建议（Top 20）
    ↓
结果写入飞书多维表格
```

---

## 目录

1. [前置要求](#1-前置要求)
2. [安装 Node.js 依赖](#2-安装-nodejs-依赖)
3. [安装并启动 n8n](#3-安装并启动-n8n)
4. [导入 n8n 工作流](#4-导入-n8n-工作流)
5. [填写你的个人信息](#5-填写你的个人信息)
6. [获取各平台 Cookie](#6-获取各平台-cookie)
7. [配置飞书多维表格](#7-配置飞书多维表格)
8. [配置大模型 API](#8-配置大模型-api)
9. [在 n8n 中填写所有参数](#9-在-n8n-中填写所有参数)
10. [启动爬虫服务并运行](#10-启动爬虫服务并运行)
11. [常见问题](#11-常见问题)

---

## 1. 前置要求

| 工具 | 版本要求 | 下载地址 |
|------|----------|----------|
| Node.js | v18 或以上 | https://nodejs.org |
| n8n | 最新版 | 见下方 |
| Chrome 浏览器 | 任意版本 | https://www.google.com/chrome |

**验证 Node.js 是否已安装：** 打开终端（Windows 按 `Win+R` 输入 `cmd`），运行：

```bash
node --version
npm --version
```

若显示版本号则已安装，否则请先按下载地址安装。

---

## 2. 安装 Node.js 依赖

下载本项目文件夹后，在终端进入项目目录并安装依赖：

```bash
cd 项目文件夹路径
npm install
```

> Windows 示例：`cd C:\Users\你的用户名\Desktop\AceHire`

安装完成后会自动生成 `node_modules` 文件夹（约 400 MB，属正常现象）。

---

## 3. 安装并启动 n8n

### 方式一：npm 全局安装（推荐新手）

```bash
npm install -g n8n
n8n start
```

n8n 启动后，浏览器打开 http://localhost:5678 即可访问。

### 方式二：Docker 安装

如果你已安装 Docker，可以用以下命令启动：

```bash
docker run -it --rm \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n
```

更多安装方式参见 [n8n 官方文档](https://docs.n8n.io/hosting/installation/)。

---

## 4. 导入 n8n 工作流

1. 打开 n8n（http://localhost:5678），完成初次注册/登录
2. 点击左上角菜单 → **Workflows**
3. 点击右上角 **Import** 按钮
4. 选择本项目中的 `Multi_Platform_Job_Hunt.json` 文件
5. 导入成功后工作流会出现在列表中，点击进入

---

## 5. 填写你的个人信息

打开项目目录中的 `user_profile.json`，用任意文本编辑器（记事本、VS Code 等）编辑：

```json
{
  "resume": "在此粘贴你的简历全文（纯文本格式）",
  "preferences": "目标岗位：xxx；岗位地点：xxx；薪资要求：xxx；排除项：xxx"
}
```

**填写说明：**

- `resume`：将你的简历复制为纯文本粘贴进来，包含教育经历、工作/实习经历、技能等。大模型会根据这份简历为每个岗位打分并给出修改建议。
- `preferences`：描述你的求职偏好，例如：
  ```
  目标岗位：前端开发工程师（最优先）、全栈工程师；岗位地点：优先北京和上海；薪资要求：20k以上；排除项：不考虑外包岗位
  ```

> **注意：** JSON 中字符串内不能直接使用换行，可以用 `\n` 代替，或参考文件中的示例格式。

---

## 6. 获取各平台 Cookie

Cookie 用于模拟已登录状态，是爬虫正常工作的关键。建议至少配置 **BOSS直聘**（其反爬机制最强）。

### 步骤

1. 安装 Chrome 插件 **[EditThisCookie](https://chromewebstore.google.com/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg)**（在 Chrome 应用商店搜索即可）

2. 在 Chrome 中**登录**对应招聘平台（保持登录状态）

3. 点击 EditThisCookie 插件图标（地址栏右侧）→ 点击**导出**按钮（看起来像一个向上的箭头）

4. 插件会把 Cookie JSON 复制到剪贴板，将内容粘贴到对应文件中：

   | 文件 | 平台 | 优先级 |
   |------|------|--------|
   | `boss_cookies.json` | BOSS直聘 | **强烈建议填写** |
   | `lagou_cookies.json` | 拉勾招聘 | 可选 |
   | `liepin_cookies.json` | 猎聘 | 可选 |
   | `zhaopin_cookies.json` | 智联招聘 | 可选 |

5. 打开对应的 `.json` 文件，把文件内容**全部替换**为粘贴的内容，保存

> **注意：** Cookie 一般有效期为 7~30 天，失效后重复上述步骤更新即可。

---

## 7. 配置飞书多维表格

工作流最终会将分析结果写入飞书多维表格。需要创建飞书应用并授权。

> 飞书开放平台官网：https://open.feishu.cn/

### 7.1 创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/) 并登录
2. 点击右上角「开发者后台」→「创建应用」→ 选择**企业自建应用**
3. 填写应用名称（随意，例如"求职助手"），点击确认创建
4. 进入应用详情页，在左侧菜单找到「凭证与基础信息」，记录：
   - **App ID**（格式类似 `cli_xxxxxxxxxxxxxx`）
   - **App Secret**（点击"查看"后复制）

### 7.2 开通权限

在左侧菜单进入「权限管理」→「添加权限」，搜索并开通以下权限：

- `bitable:app` — 多维表格的读写权限

开通后点击「申请发布」（企业自建应用会直接生效，无需审核）。

### 7.3 创建多维表格

在飞书 App 或网页版中新建一个**多维表格**，并手动添加以下字段（字段名必须完全一致）：

| 字段名 | 字段类型 |
|--------|----------|
| 职位名称 | 文本 |
| 公司名称 | 文本 |
| 招聘平台 | 文本 |
| 薪资范围 | 文本 |
| 工作地点 | 文本 |
| 匹配度评分 | 数字 |
| 匹配理由 | 文本 |
| 简历修改建议 | 文本 |
| 职位链接 | 文本 |
| 采集日期 | 文本 |

### 7.4 获取 App Token 和 Table ID

打开刚创建的多维表格，查看浏览器地址栏 URL：

```
https://xxx.feishu.cn/base/bascnXXXXXXXXXX?table=tblXXXXXXXXXX
                           ↑ App Token             ↑ Table ID
```

复制并保存这两个值，下一步会用到。

### 7.5 将应用添加为表格协作者

回到飞书多维表格，点击右上角「...」→「添加文档应用」，搜索你创建的应用名称，添加并给予**编辑权限**。

> 如果跳过此步，写入时会报权限错误。

---

## 8. 配置大模型 API

工作流使用与 Claude API 兼容的接口进行岗位匹配和简历建议生成。你需要一个支持 Claude 格式的 API。

**推荐方式：使用 Anthropic 官方 API**

1. 访问 https://console.anthropic.com/ 注册账号
2. 在「API Keys」页面创建一个新密钥
3. 记录以下信息用于下一步配置：
   - `llmBaseUrl`：`https://api.anthropic.com`
   - `llmToken`：你的 API Key（格式 `sk-ant-xxxxxx`）
   - `llmModel`：`claude-opus-4-6`（或 `claude-sonnet-4-6` 以节省费用）

> 也支持其他兼容 Claude API 格式的第三方服务，修改 `llmBaseUrl` 和 `llmToken` 即可。

---

## 9. 在 n8n 中填写所有参数

1. 在 n8n 中打开导入的工作流
2. 双击「**配置参数**」节点（通常是第二个节点）
3. 找到并修改以下字段：

| 字段 | 说明 | 示例值 |
|------|------|--------|
| `keywords` | 搜索关键词数组 | `["前端开发", "React", "Vue.js"]` |
| `cityCode` | 城市代码 | 见下方城市代码表 |
| `maxJobsPerPlatform` | 每平台最多采集数量 | `25` |
| `feishuAppId` | 飞书应用 App ID | `cli_xxxxxxxxxxxxxx` |
| `feishuAppSecret` | 飞书应用 App Secret | `xxxxxxxxxxxxxxxx` |
| `feishuAppToken` | 飞书多维表格 App Token | `bascnXXXXXXXXXX` |
| `feishuTableId` | 飞书多维表格 Table ID | `tblXXXXXXXXXX` |
| `scraperApiUrl` | 本地爬虫服务地址 | `http://localhost:3001` |
| `llmBaseUrl` | 大模型 API 地址 | `https://api.anthropic.com` |
| `llmToken` | 大模型 API Token | `sk-ant-xxxxxxxx` |
| `llmModel` | 使用的模型 | `claude-opus-4-6` |

**常用城市代码：**

| 城市 | 代码 |
|------|------|
| 北京 | `101010100` |
| 上海 | `101020100` |
| 广州 | `101280100` |
| 深圳 | `101280600` |
| 杭州 | `101210100` |
| 成都 | `101270100` |
| 武汉 | `101200100` |
| 南京 | `101190100` |
| 西安 | `101110100` |
| 苏州 | `101190400` |

4. 修改完成后点击节点右上角保存，然后保存整个工作流（`Ctrl+S`）

---

## 10. 启动爬虫服务并运行

### 每次使用前，先启动本地爬虫服务

打开一个**新的终端窗口**，进入项目目录，运行：

```bash
node scraper_api_server.mjs
```

看到以下输出说明启动成功：

```
[Server] 爬虫 API 服务已启动，监听端口 3001
[Server] 接口：POST /scrape/:platform  GET /health  GET /profile
```

> **重要：** 这个终端窗口运行期间不要关闭。运行结束后可以按 `Ctrl+C` 停止。

### 手动触发工作流

在 n8n 工作流界面，点击右上角 **「Test workflow」** 按钮即可立即运行一次。

工作流运行约需 5~15 分钟（取决于采集数量），完成后打开飞书多维表格查看结果。

### 设置定时自动运行

工作流已预设每个工作日早上 8:00 自动触发。确认方式：
1. 双击第一个节点「**Schedule Trigger**」
2. 检查 Cron 表达式为 `0 8 * * 1-5`

只要 n8n 服务和爬虫服务都在运行，就会自动执行。

---

## 11. 常见问题

**Q: 爬虫服务没启动，工作流会怎样？**

A: 采集节点会对每个连接失败的平台单独捕获错误并跳过，不会整体中断。最终只包含成功采集的平台数据。

**Q: BOSS直聘返回空数据或报错？**

A: 最常见原因是 Cookie 失效。重新登录 BOSS直聘，用 EditThisCookie 导出并更新 `boss_cookies.json`。

**Q: 飞书写入报权限错误（403）？**

A: 检查以下两点：
- 飞书应用是否已开通 `bitable:app` 权限
- 多维表格是否已将该应用添加为协作者（第 7.5 步）

**Q: 大模型返回格式解析失败？**

A: 工作流内置降级逻辑：解析失败时自动返回前 20 个职位，匹配理由标注「LLM服务暂时不可用」。通常是 API Token 错误或余额不足，检查 API 配置即可。

**Q: `npm install` 安装很慢？**

A: 设置国内镜像源：

```bash
npm config set registry https://registry.npmmirror.com
npm install
```

**Q: n8n 提示端口 5678 被占用？**

A: 指定其他端口启动：

```bash
n8n start --port 5679
```

然后浏览器访问 http://localhost:5679。

---

## 项目文件说明

```
AceHire/
├── Multi_Platform_Job_Hunt.json      # n8n 工作流定义（导入此文件）
├── scraper_api_server.mjs            # 本地爬虫 HTTP API 服务（端口 3001）
├── boss_zhipin_scraper.mjs           # BOSS直聘爬虫
├── lagou_scraper.mjs                 # 拉勾招聘爬虫
├── liepin_scraper.mjs                # 猎聘爬虫
├── zhaopin_scraper.mjs               # 智联招聘爬虫
├── user_profile.json                 # 你的简历和求职偏好（需填写）
├── platform_scraper_config.json      # 爬虫配置
├── boss_zhipin_config.json           # BOSS直聘专项配置
├── boss_cookies.json                 # BOSS直聘 Cookie（需填写）
├── lagou_cookies.json                # 拉勾 Cookie（可选）
├── liepin_cookies.json               # 猎聘 Cookie（可选）
├── zhaopin_cookies.json              # 智联 Cookie（可选）
└── package.json                      # Node.js 依赖声明
```
