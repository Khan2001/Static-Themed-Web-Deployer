# TopicWeb

独立的静态专题页面托管服务：管理员上传 ZIP，校验并解压后，通过 `/topicweb/{id}/` 公开访问。

## 启动

```bash
cp .env.example .env
# 修改 .env 中的 ADMIN_PASSWORD
docker compose up -d --build
```

管理页面：`http://你的IP:8088/manage/`

专题页面：`http://你的IP:8088/topicweb/1/`

ZIP 根目录需包含 `index.html`；如果根目录只有一个文件夹，服务会自动进入该文件夹查找入口文件。专题文件保存于 `data/sites/{id}/`，备份整个 `data` 目录即可。

主站专题入口的 URL 可填写 `http://你的IP:8088/topicweb/1/`。生产环境建议改用独立域名，并只允许可信管理员上传。

## 修改数据保存位置

通过 `.env` 中的 `TOPICWEB_DATA_ROOT` 指定宿主机数据目录。例如：

```env
TOPICWEB_DATA_ROOT=/srv/data/topicweb
```

目录中会保存专题文件、历史版本和管理员认证文件：

```text
/srv/data/topicweb/
├── sites/
├── tmp/
└── auth.json
```

## 管理员账号

默认账号为 `admin`，不提供注册。首次启动时使用 `.env` 中的 `ADMIN_PASSWORD` 初始化密码；之后密码保存为 `data/auth.json` 中的加盐哈希，修改 `.env` 不会覆盖已经保存的密码。

管理页面支持退出登录和修改密码。修改密码后当前会话会失效，需要使用新密码重新登录。

## 管理操作

- 上传新版本：在专题列表中选择“上传新版本”，原编号和链接保持不变。
- 下线/重新发布：下线时公开目录会被清空，历史版本保留。
- 版本管理：展开版本列表，可以将任意历史版本重新发布。
- 删除：删除专题及全部版本，编号不会自动复用。
- 上传进度：大文件上传会显示浏览器已上传百分比。

版本目录结构：

```text
data/sites/1/
  index.html                 # 当前公开版本
  versions/v1/               # 历史版本
  versions/v2/
  .topicweb.json
```
