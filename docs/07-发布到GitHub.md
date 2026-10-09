# 发布到 GitHub（步骤 + 指令）

目标：把 agh-signal 变成一个可公开访问的代码仓库，既满足赛事"获奖后公开赛事代码库"的要求，
也顺便成为提交材料里的"可运行作品（代码仓库）"。

前置状态（2026-10-09 核对）：git 2.55.0 已装；`gh` 命令行未安装；git 全局身份未配置；
D 盘项目还不是 git 仓库。

---

## 第 0 步：配置 git 身份（必需）

```powershell
git config --global user.name "你的名字或昵称"
git config --global user.email "你的邮箱"
```

不想动全局配置的话，可以只写进本仓库（发布脚本支持）：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\publish-github.ps1 -NoPush -GitUserName "你的名字" -GitUserEmail "你的邮箱"
```

---

## 第 1 步：发布前体检（别把隐私推上去）

```powershell
Set-Location 'D:\dev\agnes-project\agh-signal'
powershell -ExecutionPolicy Bypass -File .\tools\preflight-publish.ps1
```

它会检查五件事：不该入库的目录、疑似密钥、本机绝对路径、大文件、git 身份与忽略规则。

绝对不能公开的东西：

- `agh-home\`：AGH 运行数据，会话正文与模型凭证引用都在里面；
- `artifacts\evidence\`：会话导出与截图，含对话正文和本机路径；
- `*.html`（会话导出）、`*.db`（会话数据库）、`node_modules\`。

项目里已经准备好 `.gitignore` 把这些排除掉，你只要不要用 `git add -f` 强行加入即可。

---

## 第 2 步：本地提交

一键（推荐）：

```powershell
Set-Location 'D:\dev\agnes-project\agh-signal'
powershell -ExecutionPolicy Bypass -File .\tools\publish-github.ps1 -NoPush
```

手工等价命令：

```powershell
git init -b main
git add -A
git status --short
git commit -m "feat: AGH 信号配时寻优与验证闭环（首个公开版本）"
```

`git status --short` 要逐行看一遍，确认没有 `agh-home`、`artifacts/evidence`、`*.html`、`*.db`。
发布脚本会在提交前拦截这些路径，比肉眼检查更稳。

---

## 第 3 步：在 GitHub 建空仓库

打开 https://github.com/new

- Repository name：`agh-signal`（或 `agn-signal-traffic` 之类，避免与同名项目混淆）
- Description：基于 Agnes Harness 的信号配时自动寻优与验证闭环
- 可见性：比赛期间想保密就选 Private，获奖或提交需要时再改 Public
  （Settings → General → 最下方 Danger Zone → Change visibility）
- 不要勾选 Add a README file / Add .gitignore / Choose a license——本地已经有了，勾了会产生冲突

愿意装 `gh`（GitHub 官方命令行）的话，也能一条命令建仓并推送：

```powershell
winget install --id GitHub.cli
gh auth login
gh repo create agh-signal --public --source . --remote origin --push
```

---

## 第 4 步：关联远程并推送

在刚建好的空仓库页面复制 HTTPS 地址，然后：

```powershell
Set-Location 'D:\dev\agnes-project\agh-signal'
git remote add origin https://github.com/<你的用户名>/agh-signal.git
git push -u origin main
```

或者直接用脚本（自动 add / set-url / push）：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\publish-github.ps1 -RepoUrl 'https://github.com/<你的用户名>/agh-signal.git'
```

认证说明：推送时会弹 Git Credential Manager 让你在浏览器里授权，授权一次以后不用再输。
如果要手动用 Personal Access Token，用 classic token 勾上 `repo` 权限即可；
不要把 token 写进 remote URL、也不要提交进任何文件。

SSH 方式：

```powershell
ssh-keygen -t ed25519 -C "你的邮箱"
git remote add origin git@github.com:<你的用户名>/agh-signal.git
git push -u origin main
```

（生成的公钥 `~\.ssh\id_ed25519.pub` 贴到 GitHub → Settings → SSH and GPG keys）

---

## 第 5 步：推送后核对（很关键，别偷懒）

```powershell
# 跟踪文件里不该出现敏感路径，下面这条应该没有任何输出
git ls-files | Select-String -Pattern 'agh-home|evidence|\.html$|\.db$|node_modules'

# 应该看到大约 40 个文件
(git ls-files | Measure-Object).Count

git remote -v
git log --oneline -1
```

再到网页上确认：仓库根能看到 `README.md`、`LICENSE`、`.gitignore`、`src/`、`plugin/`、`docs/`，
并且看不到 `artifacts/evidence`、`agh-home`。

---

## 第 6 步：后续更新

```powershell
Set-Location 'D:\dev\agnes-project\agh-signal'
git add -A
git commit -m "fix: 修正基线参数口径"
git push
```

改了 `plugin\index.mjs` 之后，别忘了按 [AGH接入与证据](02-AGH接入与证据.md) 重新走一遍插件的检查与启用。

---

## 第 7 步：和赛事的对应关系

- 官方要求：20 支获奖队伍要在结果公布后 5 个工作日内公开赛事代码库（含原创代码、配置模板、
  README 与复现说明），这是奖金发放条件之一。现在把仓库建好，等于提前满足。
- 提交材料里的"可运行作品（在线体验链接、代码仓库、安装包或可复现运行说明）"可以直接填仓库地址。
- README 里最好写清：环境要求（Node 24+）、三条快速开始命令、六个工况的含义、验证怎么复现
  （同一 seed、同一命令、结果一致）。评审复现得了，分数自然高。

---

## 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 推送被拒：超过文件大小限制 | 单文件超过 100MB | 先用 preflight-publish.ps1 查大文件；已提交的用 git rm --cached 后重新提交 |
| remote origin already exists | 重复添加 | git remote set-url origin <地址> |
| 推送时要求输入账号密码 | GitHub 已停用密码认证 | 用凭据管理器授权，或用 classic PAT（勾 repo） |
| 仓库里出现了 artifacts/evidence | .gitignore 被绕过（git add -f） | git rm -r --cached artifacts/evidence 后提交 |
| 中文文件名显示成转义序列 | git 默认转义非 ASCII | git config --global core.quotepath false |
| 每行都显示 CRLF 改动 | 换行符差异 | 项目已提供 .gitattributes，首次提交后即稳定 |
