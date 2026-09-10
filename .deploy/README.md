# MAIC 部署（阿里云轻量服务器）

生产站点：**https://maic.omnisource.xin**（服务器 `47.116.20.229`，与已有的 `omnisource.xin` watchtower 同机共存）。

## 拓扑

一台 4C8G / 70G 的阿里云轻量服务器上同时跑着两套互不干扰的服务：

| 组成 | 容器 / 进程 | 监听 | 网络 |
|---|---|---|---|
| watchtower（已有） | `watchtower`, `redis` | `127.0.0.1:8788`, `172.17.0.1:6379` | `bridge` |
| **MAIC（本项目）** | `maic`, `maic-postgres` | `127.0.0.1:3000`，PG 仅容器内 | `maic-net` |

两套共用宿主机 nginx 终结 TLS，按域名分发：`omnisource.xin` → 8788，`maic.omnisource.xin` → 3000。两套各自使用独立的 docker network 和独立数据库，唯一的共享资源是 nginx 和宿主机磁盘。

文件布局：

- 服务器：`/root/maic/{maic-app.env, maic-pg.env, data/, pgdata/}`；nginx 站点 `/etc/nginx/conf.d/maic.conf`
- 证书：阿里云签发的 DigiCert 证书，`/etc/nginx/ssl/maic.omnisource.xin.{pem,key}`（手动上传，2026-12-08 到期，需自行续期）
- 本地：`.deploy/{maic-nginx.conf, make-env.mjs, deploy-maic.sh}`

## 日常更新

镜像在**本地**构建（服务器只剩约 3G 内存，跑不动 Next 构建），再流式传到服务器：

```bash
bash .deploy/deploy-maic.sh
```

脚本做四件事：本地 `docker build`（linux/amd64）→ `docker save | gzip | ssh docker load`（不落中间文件）→ 重建 `maic` 容器 → 轮询 `/api/health` 就绪并打印日志。

密钥不在命令行里出现：运行时环境文件由 `.deploy/make-env.mjs` 从 `.env.local` 生成，单独 scp。

## 环境文件为什么需要生成器

`docker run --env-file` 与 Next.js 的 dotenv 解析规则不同，直接把 `.env.local` 交给 Docker 会出错：

1. **引号**：dotenv 会剥掉值两侧的引号，Docker 不会。`.env.local` 里的 `MODEL_ROUTES='{...}'` 一旦原样传入，`JSON.parse` 就会失败（`lib/server/config-validation.ts` 只在启动日志里 warn，服务照常起来但模型路由被忽略）。
2. **构建期变量**：`NEXT_PUBLIC_*` 在构建时被内联进浏览器产物，运行时不需要、也不应该出现在容器环境里。
3. **部署专属变量**：`DATABASE_URL`、`TEACHER_SESSION_SECRET`、`TEACHER_BOOTSTRAP_PASSWORD` 属于部署机密，不应进仓库。

`make-env.mjs` 按 dotenv 语义解析（引号、` #` 行内注释、重复键取最后一条），剔除 `NEXT_PUBLIC_*`，再用 `--set` 追加部署变量。

```bash
node .deploy/make-env.mjs --source .env.local --out /tmp/maic-app.env \
  --set "DATABASE_URL=postgres://maic:PASS@maic-postgres:5432/maic?sslmode=disable" \
  --set "TEACHER_SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  --set "TEACHER_BOOTSTRAP_PASSWORD=..."
```

## 数据库

PostgreSQL 16 跑在 `maic-postgres` 容器里，数据卷 `/root/maic/pgdata`，只对 `maic-net` 可见（不映射到宿主机，减少暴露面）。

- 建表和首个管理员都是**应用启动时自动完成**的（`lib/server/db/pg.ts` 的 `ensureCoursewareDatabase`），不需要手工迁移。
- 管理员账号 `admin`，初始密码取 `TEACHER_BOOTSTRAP_PASSWORD`。**播种只在 `teachers` 表为空时发生**，之后改环境变量无效；要改密码用 `scripts/set-teacher-password.mjs`。

备份（容器在跑也能安全执行）：

```bash
ssh root@47.116.20.229 'docker exec maic-postgres pg_dump -U maic -d maic | gzip' > maic-$(date +%F).sql.gz
```

## nginx 与证书

站点配置 `.deploy/maic-nginx.conf`，两处和默认配置不同，都是必需的：

- `proxy_buffering off` + 长超时：AI 流式响应（SSE）靠这个逐 token 下发，否则会被缓冲成一整块或提前断开。
- `client_max_body_size 200m`：课件上传（PPTX/PDF/ZIP）。

`listen 443 ssl http2`（而非 `http2 on`）：服务器的 nginx 是 1.24，独立 `http2` 指令要 1.25.1 才支持。

证书是**阿里云签发的 DigiCert 证书**，手动安装到 `/etc/nginx/ssl/maic.omnisource.xin.{pem,key}`（与 `omnisource.xin` 同一套做法）。SAN 覆盖 `maic.omnisource.xin` 和 `www.maic.omnisource.xin`，有效期至 **2026-12-08**。

**到期续期**（没有 ACME 自动续期，必须手动）：

1. 在阿里云数字证书控制台下载该域名的新 nginx 格式证书（会得到一个含 `.pem` 和 `.key` 的目录）。
2. 上传覆盖服务端两个文件，然后 reload：

```bash
scp maic.omnisource.xin.pem maic.omnisource.xin.key root@47.116.20.229:/tmp/
ssh root@47.116.20.229 '
  install -m 644 /tmp/maic.omnisource.xin.pem /etc/nginx/ssl/maic.omnisource.xin.pem
  install -m 600 /tmp/maic.omnisource.xin.key /etc/nginx/ssl/maic.omnisource.xin.key
  rm -f /tmp/maic.omnisource.xin.{pem,key}
  nginx -t && nginx -s reload'
```

安装前先核对证书与私钥是否匹配（两份 modulus 的 md5 必须相同），装错了 nginx 会起不来：

```bash
echo "cert: $(openssl x509 -in maic.omnisource.xin.pem -noout -modulus | openssl md5)"
echo "key:  $(openssl rsa  -in maic.omnisource.xin.key  -noout -modulus | openssl md5)"
```

`www.maic.omnisource.xin` 已在 vhost 的 `server_name` 里，但**还需要单独加一条 DNS A 记录**才会生效。

## 新挂一个二级域名要做什么

以 `foo.omnisource.xin` 为例（本次部署就是这样加上 `maic` 的）。证书用阿里云签发的就少几步：

1. **加 DNS 解析**：在阿里云 DNS 给 `foo` 加一条 A 记录指向 `47.116.20.229`，等 `getent hosts foo.omnisource.xin` 能查到。
2. **申请证书**：在阿里云数字证书控制台为 `foo.omnisource.xin` 申请一张 DV 证书并下载 nginx 格式。
3. **上传证书并按上面的命令安装**，校验 modulus 匹配。
4. **写 vhost**：照抄 `.deploy/maic-nginx.conf` 改 `server_name` 和 proxy_pass 端口，`nginx -t` 通过后 `nginx -s reload`。

也可以在服务器上申请（无需阿里云控制台，且能自动续期）：先只放一个 80 端口、放开 `/.well-known/acme-challenge/` 的 vhost（证书还没签，直接写引用证书的 HTTPS 配置会让 `nginx -t` 失败），再执行：

```bash
certbot certonly --nginx -d foo.omnisource.xin --non-interactive --agree-tos --register-unsafely-without-email
```

然后把 vhost 的 `ssl_certificate` 指向 `/etc/letsencrypt/live/foo.omnisource.xin/{fullchain,privkey}.pem`。`certbot-renew.timer` 已启用，续期自动完成。

## 已知问题与修复

- **`sharp` 原生库缺失**（本次修复）：Next.js 的 standalone 文件追踪看不到 `dlopen` 加载的 `libvips-cpp.so`，产物里只留了 sharp 的 JS 壳，运行时 `require('sharp')` 抛 `ERR_DLOPEN_FAILED`，进而导致 **Agent Runtime 启动失败、课件生成不可用**（HTTP 仍正常，所以很容易漏掉）。修复是在 `next.config.ts` 的 `outputFileTracingIncludes` 里显式锚定 `node_modules/@img/sharp-libvips-linuxmusl-*/**`。runner 镜像是 alpine，只有 musl 版本相关。
- **`.dockerignore` 的 `node_modules` 只匹配根目录**：`packages/*/node_modules` 会进构建上下文，与 deps 阶段的目录在同一路径冲突，`COPY . .` 报 `cannot copy to non-directory`。修复是改成 `**/node_modules`（`dist` 同理）。
- **`NEXT_PUBLIC_PRO_WORKBENCH_ENABLED` 未在 Dockerfile 声明**：该开关是构建期变量且默认关闭，Docker 部署下 `/workspace`（Pro 工作台）会被静默关掉。已补进 Dockerfile 与 docker-compose 的 build args。

## 改环境变量必须重建容器（`docker restart` 无效）

**`docker restart` 不会重新读取 `--env-file`** —— 它复用容器创建时固化的环境变量。改完 `maic-app.env` 后 `docker restart maic`，`docker exec maic printenv` 仍是旧值，看起来"改了没生效"。

必须删掉容器重新 `docker run`（这正是 `deploy-maic.sh` 的做法）：

```bash
ssh root@47.116.20.229
cd /root/maic
cp maic-app.env "maic-app.env.bak.$(date +%s)"   # 先备份
# 编辑 maic-app.env 后：
docker rm -f maic
docker run -d --name maic --restart unless-stopped \
  --network maic-net -p 127.0.0.1:3000:3000 \
  -v /root/maic/data:/app/data --env-file /root/maic/maic-app.env maic:local

# 验证容器真的读到了新值（不要只看文件内容）：
docker exec maic printenv DEEPSEEK_BASE_URL
```

`deploy-maic.sh` 里生成的 `/tmp/maic-app.env` 是完整快照（130 个变量），覆盖上去即可；改前先用 `diff` 确认差异只有你预期的那几行，避免误删配置。

## 切换模型 / provider

模型由服务端环境变量锁定（`<PROVIDER>_MODELS`），设置界面里对应的编辑按钮**是隐藏的**（`modelsLocked`），所以这类改动只能走配置：

- `DEEPSEEK_BASE_URL` 换端点，`DEEPSEEK_API_KEY` 换密钥，`DEEPSEEK_MODELS` 换模型（第 0 项即默认）。
- 改完按上一节重建容器。
- 端到端验证（走应用自身的模型解析与调用链路，不是只测网络）：

```bash
curl -s -X POST https://maic.omnisource.xin/api/verify-model \
  -H "Content-Type: application/json" -d '{"model":"deepseek:deepseek-flash"}'
# 期望：{"success":true,"message":"Connection successful","response":"OK"}
```

`GET /api/server-providers` 可查看服务端实际生效的 provider 与模型清单（密钥不外泄）。
