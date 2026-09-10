# OpenMAIC UI 设计规范速查（以 /workspace 为基准）

本文件是给 AI 助手（以及新加入的同学）的**UI 设计知识库**：当我们说"按 workspace 的风格做"或"对齐 Pro 的设计标准"时，以本文件为准。全部依据来自现行实现，改动组件时先读对应源码。

## 0. 为什么 /workspace 是基准

`components/workbench/workspace/WorkspaceShell.tsx` + `components/workbench/workspace-shell.css`（以下称 ws 体系）是本产品打磨最充分的界面：设计令牌齐全（含暗色模式与对比度指标）、交互细节经过多轮验收（折叠/拖宽/分页/拖拽排序/右键重命名）。新界面（如教师端 `/teacher`）**优先复用其模式与令牌**，而不是再造一套 shadcn 默认样式。

## 1. 设计令牌（`.ws-root` 上声明，dark 变量在 workspace-shell.css 内）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--ws-ink` / `-soft` / `-mute` / `-faint` | slate-900/700/500/400 | 文字四级：主文字 / 次文字 / 元数据按钮（AA 4.7:1）/ 仅装饰线，**faint 禁止做文字** |
| `--ws-line` / `-line-soft` | 11% / 6.5% slate | 分隔线 / 更弱的缝 |
| `--ws-tint` / `-tint-strong` | 5.5% / 9% slate | hover 底色 / 按下底色 |
| `--ws-rail` / `--ws-surface` | 半透明白 + blur | 左栏 / 面板底，canvas 是 slate-50→100 渐变 |
| `--ws-accent` | `#7c3aed` violet-600 | 全产品唯一强调色；ring 用 `--ws-accent-thread` |
| `--ws-ease` | `cubic-bezier(0.22,0.61,0.36,1)` | 所有过渡统一缓动，时长多用 140–160ms |
| `--ws-pane-head-h` | 42px | 所有面板头统一高度，保证跨接缝的 hairline 不错位 |
| `--ws-tree-row-h` / `--ws-tree-indent` / `--ws-tree-lead(-gap)` | 32px / 12px / 16px+8px | 树形列表行高、唯一缩进步、文件夹前导图标位 |

Tailwind 侧的对应习惯（不引 css 时）：muted-foreground≈ink-mute、bg-muted≈tint、ring-primary/40≈accent-thread。

## 2. 布局骨架

- 三栏：左 rail（可折叠可拖宽，默认约 260px，折叠成 60px 图标条）+ 会话中栏 + 课堂右栏。全高 `h-[100dvh]`，root 有 `overflow-hidden`。
- **每个可折叠面板从自己的 header 折叠**（`PaneFoldButton`），接缝（seam）只负责拖宽。一条线只能有一个含义。
- 面板头 42px、底部 hairline 用 `--ws-line`；两栏 header 的线必须跨接缝对齐（都用 `--ws-pane-head-h`）。
- 交互的"安静"优先：低频操作收进角落或 `⋯`，主路径（导航、发送）占据显著位置。

## 3. 底部 utilities 簇（本次教师端参照的模式）

源码：`WorkspaceRail.tsx` 的 `RailUtilities`。要点：

- 顶部一条 `--ws-line` 发缝（`ws-seam-rail`），下面一行 32px 圆形图标按钮（`ws-util-btn`）：静息态 `--ws-ink-mute`，hover 变 `--ws-tint` 底 + `--ws-ink` 字，focus 是 1px accent ring。
- 常用（语言、主题、设置）直接露出；低频收进 `⋯`（`RailOverflow`，向上弹出的 portalled 面板）。
- 每个图标按钮必须有 `aria-label` + tooltip（`side` 朝内容区）。
- 教师端对应实现：`app/teacher/(protected)/layout.tsx` 的 `FootButton`（Tailwind 版同视觉：size-8 rounded-full text-muted-foreground hover:bg-muted）。

## 4. 图标按钮 / 行的通用规格

- 图标按钮：32px 圆形（工具栏内 28px），lucide `size-4`，stroke 1.75–2.5；只图标必须有 tooltip + aria-label。
- 列表行：32px 高单行；激活 = 淡紫底 + accent ring/文字，hover = `--ws-tint`；名字 truncate；计数/状态放行尾。
- 主按钮：violet-600 实底白字；次按钮：border + 背景/70；危险操作必须二次确认（AlertDialog）。
- 弹层（popover/menu）portalled 到面板根或 body，避免被 `overflow-hidden`/`backdrop-filter` 裁切 —— 见 `RailOverflow` 的注释。

## 5. 动效规范

- 时长 140–200ms，统一 `--ws-ease`；面板开合用透明度 + 尺寸，不做大幅位移。
- 路由级 Pro↔普通切换用共享元素 morph（`lib/workbench/pro-swap.ts` 的 `startProSwap`），无 View Transitions 或 reduced-motion 时降级为普通跳转。
- 骨架屏 shimmer 只用于占位（生成中的缩略图），不要用于已有内容。

## 6. 路由契约（谁回到谁）

- `/workspace` 的"退出 Pro"（ProBadge、hero 的返回箭头）经 `WorkspaceShell.exitPro` → `exitHref` prop：教师会话时去 **`/teacher/courses`**（教师的普通模式=运营后台），否则回 `/`（学生端）。目的地由 `/workspace` 路由（server component）解析——`openmaic_teacher` 是 httpOnly 签名 cookie，`document.cookie` 读不到，客户端嗅探永远失效（2026-09-10 修的 bug 就在这里），所以必须服务端 `verifyTeacherSessionToken` 后经 prop 传入。
- 课堂页的返回箭头（CommandBar 左箭头）由 `lib/workbench/classroom-exit.ts` 决定：`?from=workspace` → `/workspace`，否则 `/`。教师编辑页是 classroom 的另一个宿主，勿在此再加分支，改 `classroom-exit.ts`。
- 教师端入口 `/teacher/courses`；学生端 `/`；编辑器 `/teacher/courses/:id/edit`。
- **学生课堂页没有 Pro 入口**：`app/classroom/[id]/page.tsx` 给 `Stage` 传 `proEntryHidden`，`Stage` 据此把 `chromeToggleHandler` 置空，`HeaderControls` 便整块不渲染 Pro Switch（学生不进编辑态、也进不了 workbench）。教师编辑器与 workspace 的课堂面板不传该标志，改用 §8 的教师入口编辑。新增 classroom 宿主时，先回答"这个宿主该不该有 Pro 入口"，不要靠 `hosted` 反推。

## 7. 禁止事项（历史教训，源码注释里都有）

1. **faint 级颜色做文字** —— 对比度 2.5:1，不可读。
2. **一行两义**（同一接缝既拖宽又折叠）、**空占位槽**（把树整体顶右）、**半行裁切**（max-height 不按整行数）。
3. 在 rail 这类有 `backdrop-filter` 的容器里直接弹 fixed 层 —— 会被当作 containing block 且遭裁切，必须 portal 出去。
4. 各自为政的面板头高度 —— 接缝 hairline 会错位。
5. 为新页面另起一套灰阶/圆角/缓动 —— 先查 §1 令牌表。

## 8. 教师端 rail 的复用决策（2026-09-10）

`/teacher/courses` 的左侧栏是 `components/teacher/TeacherRail.tsx`：**视觉层 100% 复用 workspace**——同一个 `workspace-shell.css`（由 `app/teacher/(protected)/layout.tsx` 导入，root 加 `ws-root` 类共享令牌作用域），行 = `ws-row/ws-tree-row/ws-course`，主操作 = `ws-new`，标签 = `ws-navtabs`，搜索 = `ws-find`，底簇 = `ws-utils/ws-util-btn` + `RailOverflow`（直接 import 自 WorkspaceRail）。差异只在数据层：课程来自 `/api/teacher/courses`（MySQL），无文件夹、无会话树。

- **设置按钮直接弹 `SettingsDialog`**（与 Pro 的 RailUtilities 同款），不跳 `/teacher/settings` 页；rail 挂载时调 `startTeacherSettingsMirror()`（幂等）保证弹框里的保存落到服务端 system_settings。`/teacher/settings` 页保留作兼容/移动端入口。
- 持久化偏好（折叠/宽度/标签）键名 `teacher.rail.*`；storage 恢复用 `useLayoutEffect` + 说明性 `react-hooks/set-state-in-effect` disable，模式照抄 `WorkspaceShell.usePaneCollapse`。
- 分页窗口按 listId（tab+query）派生校验，不用 effect 重置。
- 若改了 WorkspaceRail 的视觉（行高、seam、tab 形状），检查 TeacherRail 是否同步——两者共用 css，类名一致即一致；结构分叉时先读本节。

## 9. 学生数据页面（2026-09-10）

`/teacher/students`（学生管理）是 master-detail 一页式：左列名单（搜索 + 最近活跃/课程数/提问数摘要），右列三段——账号资料（重置密码/删除）、每门课学习进度（进度条 = max_seen_order/scene_count，服务端只记最大页码防回退）、助教问答记录。数据采集两处：课堂播放器在 scene 切换时 POST `/api/student/progress`（仅学生登录态）；`/api/student/chat` 对登录学生落库问答（问题即时、答案流结束后补写）。教师数据权限：admin 见全部，teacher 仅见自己邀请码注册的学生（`student_invites.created_by` 是归属链）。

## 10. 课件封面（学生端课程库卡片）

- 卡片背景=**封面图**：`courses.cover_asset_id` 指向 `course_assets` 里的一张图（bytes 在库里），公开地址走既有的 `/api/assets/<id>`（不可猜 id、immutable 缓存），因此 `listCoursesForTeacher` / `listPublishedCourses` 都带 `coverUrl`（无封面为 null）。
- **默认取第一页**：AI 生成的课件自身没有图片，`lib/teacher/cover-image.ts` 用 `slideToPng` 把第一张可渲染页面（按 order、跳过 quiz/interactive、跳过空页）栅格化成 1280×720 PNG 再上传。教师详情页在"没有封面"时自动跑一次（每次访问一次，失败不重试）；也能手动「用第一页生成」或「上传封面」覆盖。
- 空页不生成封面：没有元素的占位页会得到一张纯白卡片，比学生端的 📄 占位更糟——`firstCoverScene` 因此跳过它，详情页给一句提示。
- 封面是课程元数据，不属于发布快照：改封面不需要重新发布，下架/再发布也不会丢。

## 11. 变更记录

- 2026-09-10 创建。依据 workspace-shell.css 现行令牌、WorkspaceRail 的 RailUtilities/RailOverflow、PaneFoldButton、pro-swap/classroom-exit 路由契约；教师端布局已按 §3 落地（后升级为 §8 的完整 rail 复用）。
- 2026-09-10 修订 §6：退出 Pro 的教师判定改由 `/workspace` 服务端解析（httpOnly cookie 客户端不可见）；教师端 layout 根节点定为 `h-[100dvh] overflow-hidden`（`min-h-screen` 会让 rail 的 `h-full` 塌成内容高），滚动只属于 `main`。
- 2026-09-10 修订 §6（学生课堂页藏 Pro 入口）、新增 §10（课件封面）：AI 老师阵容头像此前把 `/avatars/*.png` 当文字打印，现改用 `components/ui/avatar-display.tsx`（同时兼容 emoji 头像）。
