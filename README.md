# TopicWeb

独立的静态专题页面托管服务。管理员通过 Web 界面上传 ZIP 压缩包，服务自动校验、解压并版本化管理，最终通过 Nginx 对外提供访问。

适用于内网环境中快速发布离线专题页面，无需数据库，无需构建工具，一个 `docker compose up` 即可运行。

## 功能

- ZIP 上传发布，自动识别单文件夹嵌套
- 多版本管理，支持回滚到任意历史版本
- 上线 / 下线控制，下线时清空公开目录但保留版本
- 大文件上传进度显示
- 管理员登录、退出、修改密码（scrypt 加盐哈希）
- 压缩包安全校验（路径穿越、可执行文件拦截、文件数量限制）
- Nginx 反向代理，隐藏版本目录和元数据文件

## 架构

```
浏览器
  │
  ▼
Nginx (:80)
  ├── /topicweb/{id}/  → 静态文件（data/sites/）
  ├── /api/            → Node.js API (:3000)
  └── /manage/         → 管理面板（Node.js 托管）
```

两个容器：

| 服务 | 镜像 | 职责 |
|------|------|------|
| topic-api | node:22-alpine | API、管理面板、ZIP 解压与版本管理 |
| topic-nginx | nginx:1.27-alpine | 静态文件服务、反向代理 |

## 快速开始

```bash
cp .env.example .env
# 编辑 .env，至少修改 ADMIN_PASSWORD
docker compose up -d --build
```

- 管理面板：`http://<IP>:8088/manage/`
- 专题页面：`http://<IP>:8088/topicweb/1/`

默认账号 `admin`，密码为 `.env` 中的 `ADMIN_PASSWORD`。

## 配置

通过 `.env` 文件设置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TOPICWEB_PORT` | `8088` | 宿主机映射端口 |
| `TOPICWEB_DATA_ROOT` | `./data` | 宿主机数据目录 |
| `ADMIN_USERNAME` | `admin` | 管理员账号（仅首次初始化生效） |
| `ADMIN_PASSWORD` | `change-me` | 初始密码（仅首次初始化生效） |
| `MAX_UPLOAD_MB` | `200` | 单次上传大小上限（MB） |

首次启动后密码保存为 `data/auth.json` 中的哈希，修改 `.env` 不会覆盖已保存的密码。

## 上传要求

- 格式：ZIP
- 根目录必须包含 `index.html`（若根目录只有一个文件夹，自动进入该文件夹查找）
- 不允许包含 `.php`、`.jsp`、`.exe`、`.sh` 等可执行文件
- 不允许路径穿越（`../`）
- 文件数量上限 10000

## 数据结构

```text
data/
├── auth.json              # 管理员凭证（自动生成）
├── tmp/                   # 上传临时目录（自动清理）
└── sites/
    └── 1/
        ├── index.html     # 当前公开版本
        ├── assets/...     # 当前版本资源
        ├── .topicweb.json # 元数据（标题、状态、版本列表）
        └── versions/
            ├── v1/        # 历史版本完整快照
            └── v2/
```

备份整个 `data` 目录即可完整恢复。

## 管理操作

| 操作 | 说明 |
|------|------|
| 上传新专题 | 分配新编号，立即发布 |
| 上传新版本 | 编号和链接不变，旧版本保留 |
| 查看版本 | 展开版本列表，可回滚到任意版本 |
| 下线 | 清空公开目录，版本保留 |
| 重新发布 | 恢复当前版本到公开目录 |
| 删除 | 删除专题及全部版本，编号不复用 |

## 安全说明

- 管理接口使用 Bearer Token 认证，会话有效期 8 小时
- 密码使用 scrypt + 随机盐存储，修改密码后所有会话失效
- Nginx 拦截对 `versions/` 和 `.topicweb.json` 的直接访问
- 静态响应添加 `X-Content-Type-Options: nosniff` 和 `Referrer-Policy` 头
- 生产环境建议修改默认端口、使用强密码，并限制管理接口的网络访问

## 技术栈

- Node.js 22（原生 HTTP，零依赖）
- Nginx 1.27
- Docker Compose
- 前端：原生 HTML / CSS / JS，无框架

## License

Private