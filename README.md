# DSH Forge

> **Turn developer CLIs into typed, safe and structured tools for DeepSeek Harness.**  
> 让 DeepSeek Harness 不只是“会写代码”，还能够安全地调用真实开发工具，完成检查、修复、验证与自动化执行。

DSH Forge 是一个面向 **DeepSeek Harness** 的开发者工具插件生态。

它把成熟的开发者 CLI 工具封装成 **类型安全（Typed）**、**权限可控（Safe）**、**结果结构化（Structured）**、**可验证（Verifiable）** 的 Agent Tools，让智能体能够完成：

```text
Understand
   ↓
Search
   ↓
Modify
   ↓
Lint / Format
   ↓
Test / CI
   ↓
Security Scan
   ↓
Container / Performance
   ↓
Verify
```

核心目标不是“让模型执行更多 Shell 命令”，而是建立一层真正适合智能体调用的：

> **Developer Tool Adapter Layer**

---

## ✨ Why DSH Forge?

传统 Coding Agent 常见的工具调用方式是：

```text
LLM
 ↓
Shell command
 ↓
Raw terminal output
 ↓
LLM guesses what happened
```

这种方式存在几个问题：

- 命令参数缺少强约束
- 容易暴露任意 Shell 执行能力
- CLI 输出可能非常长且难以解析
- 文件修改、网络访问和系统操作缺少统一权限分类
- 很难形成稳定的“修复 → 再验证”闭环

DSH Forge 将这一过程改造成：

```text
DeepSeek Harness
      ↓
Typed Tool
      ↓
Safe Adapter
      ↓
Structured Execution
      ↓
Normalized Result
      ↓
Agent Reasoning
      ↓
Fix / Retry / Verify
```

---

## 🚀 Current Status

**Current release: `v0.3.0`**

目前已经完成：

- **10 个核心插件**
- **1 个统一 Core SDK**
- **1 套 Quality & Security Gate**
- **7 个 Presets**
- **471+ automated tests**
- **Ubuntu / Windows CI**
- **Issue-driven + TDD development**
- **Independent external-model PR review**
- **GitHub Releases: v0.1.0 / v0.2.0 / v0.3.0**

当前正在向 **v1.0.0** 推进。

---

# 🧩 Plugin Ecosystem

## 1. ast-grep — Structural Code Search & Rewrite

让 DeepSeek 不再只能依赖文本搜索，而是可以基于 AST 理解和修改代码结构。

主要能力：

- 结构化代码搜索
- AST Pattern Scan
- 规则检查
- 批量代码 Rewrite
- API Migration
- 重构场景支持

示例：

```text
Find all deprecated API calls
        ↓
ast-grep search
        ↓
Locate structural matches
        ↓
Rewrite
        ↓
Rescan
```

---

## 2. Ruff — Python Quality

为 Python 项目提供高速代码质量检查和格式化能力。

支持：

- `ruff_check`
- `ruff_format_check`
- `ruff_explain`
- `ruff_fix`
- `ruff_format`

典型流程：

```text
ruff_check
   ↓
12 diagnostics
   ↓
DeepSeek reasons
   ↓
ruff_fix
   ↓
ruff_check
   ↓
0 errors
```

---

## 3. Biome — Web / JS / TS Quality

面向：

- JavaScript
- TypeScript
- JSX
- TSX
- JSON

提供：

- Lint
- Format Check
- Fix
- Format

可作为 Web 生态中与 Ruff 对应的代码质量工具。

---

## 4. uv — Python Environment & Dependency Management

帮助 Agent 管理 Python 项目环境和依赖。

支持：

- 依赖同步
- 依赖树查看
- 添加依赖
- 删除依赖
- 运行 Python 命令
- 项目环境管理

解决 Coding Agent 常见问题：

> “代码写好了，但环境跑不起来。”

---

## 5. act — Local GitHub Actions

让 DeepSeek 能够在本地执行 GitHub Actions 工作流。

支持：

- Workflow discovery
- Job discovery
- Local workflow run
- Job execution
- Failure status
- CI result analysis

流程：

```text
Modify code
   ↓
Run GitHub Actions locally
   ↓
Failure
   ↓
Analyze
   ↓
Fix
   ↓
Run again
   ↓
PASS
```

---

## 6. Semgrep — Source Code Security

提供源码级静态安全分析。

支持：

- Repository Scan
- File Scan
- Security Rules
- Structured Findings
- Source-code vulnerability detection

适用于：

- Unsafe API usage
- Injection risk
- Dangerous coding patterns
- Security regression checking

---

## 7. Trivy — Supply Chain & Container Security

覆盖更加广泛的软件供应链安全能力：

- Filesystem scan
- Container image scan
- IaC / configuration scan
- Secret detection
- Vulnerability detection
- SBOM

主要能力：

```text
trivy_fs
trivy_image
trivy_config
trivy_sbom
trivy_version
```

---

## 8. Quality & Security Gate

Quality Gate 不是重新实现 Ruff、Biome、Semgrep 或 Trivy。

它负责将多个工具组合成一个统一检查流程：

```text
Detect project
      ↓
Ruff / Biome
      ↓
Semgrep
      ↓
Trivy
      ↓
Normalized Result
```

最终输出：

```text
PASS
PASS_WITH_WARNINGS
FAIL
```

让 Agent 能快速判断当前项目是否达到质量门槛。

---

## 9. Docker — Container Operations

将常见 Docker 操作转换为类型化、权限可控的 Agent Tools。

支持读取：

- Docker status
- Containers
- Images
- Logs
- Inspect
- Compose status

支持受控写操作：

- Build
- Compose up
- Compose down
- Run
- Exec

高风险操作不会被简单暴露为任意 Shell。

---

## 10. k6 — Performance & Load Testing

让 Agent 能够直接执行：

- Smoke Test
- Load Test
- Stress Test
- Threshold Check
- Performance Summary

示例：

```text
Start service
   ↓
k6 load test
   ↓
P95 too high
   ↓
Analyze bottleneck
   ↓
Optimize
   ↓
Run again
```

---

## 11. FFmpeg — Media Operations

将复杂 FFmpeg 命令转换成高层、类型化操作。

支持：

- Media probe
- Video clip
- Transcode
- Concat
- Audio extract
- Audio convert
- Thumbnail generation
- Compression

例如：

```text
Probe video
   ↓
Clip segment
   ↓
Compress
   ↓
Verify output
```

而不是让模型拼接任意 FFmpeg Shell 命令。

---

# 📦 Presets

为了避免用户逐个配置插件，DSH Forge 提供组合式 Presets。

## Coding

```text
ast-grep
Ruff
Biome
```

适合一般软件开发与重构。

## Python

```text
Ruff
uv
```

适合 Python 项目。

## Web

```text
Biome
ast-grep
```

适合 JavaScript / TypeScript 项目。

## Security

```text
Semgrep
Trivy
Quality Gate
```

适合安全扫描与质量门禁。

## DevOps

```text
act
Docker
k6
```

适合 CI/CD、容器和性能验证。

## Media

```text
FFmpeg
```

适合多媒体任务。

## Full

加载完整 DSH Forge 工具生态。

---

# 🛡️ Safety by Design

DSH Forge 的核心理念不是“执行更多命令”，而是：

> **让智能体以更受控的方式调用开发者工具。**

## Typed Arguments

避免：

```text
command: "some arbitrary shell..."
```

而使用：

```text
tool({
  file,
  rule,
  options
})
```

参数经过显式 Schema 验证。

---

## No Arbitrary Shell

默认采用：

```text
binary + argv[]
```

而不是：

```text
shell=true
```

避免把任意 Shell 权限直接交给 Agent。

---

## Workspace Boundary

写操作默认必须限制在当前 Workspace 中。

默认阻止：

- `../` Path Traversal
- Absolute path escape
- Symlink escape

避免智能体误修改工作区以外的文件。

---

## Mutation Classification

工具按照副作用被分类为：

```text
read
workspace-write
network
process
system-change
destructive
```

为 DeepSeek Harness 的权限系统提供明确的操作语义。

---

# 📊 Structured Results

传统 CLI 可能一次返回几百甚至几千行终端文本。

DSH Forge 尽量将工具结果转换为统一的结构化诊断：

```ts
interface Diagnostic {
  tool: string
  severity: 'info' | 'warning' | 'error' | 'critical'
  rule?: string
  file?: string
  line?: number
  column?: number
  message: string
  suggestion?: string
  fixable?: boolean
}
```

Agent 因此可以直接理解：

- 出了什么问题
- 在哪个文件
- 哪一行
- 严重程度
- 是否可以自动修复

而不必重新从一大段终端输出中猜测。

---

# 🔁 Agent Development Loop

DSH Forge 希望帮助 DeepSeek Harness 从：

> **“能够生成代码”**

进一步变成：

> **“能够调用工具验证自己工作的开发智能体”**

完整闭环：

```text
Understand
    ↓
Search
    ↓
Modify
    ↓
Lint
    ↓
Format
    ↓
Test / CI
    ↓
Security
    ↓
Performance
    ↓
Verify
```

即：

> **Reason → Fix → Retry → Verify**

---

# 🧪 Engineering Quality

DSH Forge 本身按照真实开源软件工程流程开发。

开发流程：

```text
Issue
 ↓
TDD RED
 ↓
TDD GREEN
 ↓
Refactor
 ↓
Pull Request
 ↓
CI
 ↓
Independent Model Review
 ↓
Regression Test
 ↓
Merge
```

目前工程质量信号包括：

- 471+ tests passing
- TypeScript typecheck
- Lint / Build verification
- Ubuntu CI
- Windows CI
- Deterministic E2E
- Plugin contract tests
- Real tool integration tests
- Independent external-model PR reviews
- Versioned GitHub releases

---

# 🏗 Architecture

```text
                        User Intent
                            │
                            ▼
                   DeepSeek Harness
                            │
                       Typed Tools
                            │
                            ▼
                     ┌───────────┐
                     │ DSH Forge │
                     └───────────┘
                            │
           ┌────────────────┼────────────────┐
           │                │                │
           ▼                ▼                ▼
     Argument          Permission        Workspace
     Validation          Policy           Boundary
           │                │                │
           └────────────────┼────────────────┘
                            │
                            ▼
                       Safe Adapter
                            │
       ┌──────────┬─────────┼──────────┬──────────┐
       ▼          ▼         ▼          ▼          ▼
    ast-grep    Ruff     Semgrep     Docker     FFmpeg
      Biome      uv       Trivy       act        k6
                            │
                            ▼
                    Structured Result
                            │
                            ▼
                   Reason / Fix / Verify
```

---

# 🗺 Roadmap

## v0.1.0

- Core SDK
- ast-grep
- Ruff
- Biome
- Basic presets
- E2E foundation

## v0.2.0

- uv
- act
- Semgrep
- Trivy
- Quality & Security Gate
- Security / DevOps presets

## v0.3.0

- Docker
- k6
- FFmpeg
- Full preset system
- Full E2E stories

## v1.0.0

Planned:

- DeepSeek Harness compatibility matrix
- Expanded documentation and examples
- Supply-chain hardening
- Release hardening
- Stable public contracts

---

# 🧭 Project Philosophy

DSH Forge is **not**:

> a collection of shell wrappers.

DSH Forge aims to be:

> **a Developer Tool Adapter Layer for DeepSeek Harness.**

We want mature developer tools to become:

**Typed · Safe · Structured · Verifiable**

agent capabilities.

---

# 🤝 Contributing

Contributions are welcome.

Before contributing, please read:

- `CONTRIBUTING.md`
- `AGENTS.md`
- `SECURITY.md`
- `docs/ARCHITECTURE.md`
- `docs/PLUGIN_STANDARD.md`

The project follows an Issue-driven and TDD-first development workflow.

---

# 📄 License

MIT

Third-party tools remain governed by their respective upstream licenses.

DSH Forge acts primarily as an adapter layer and does not treat upstream tools as reimplemented project code.

---

# ⭐ Support

If DSH Forge is useful to you:

- Star the repository
- Try the plugins
- Report issues
- Suggest new developer-tool adapters
- Contribute a new plugin

> **Forge better tools for DeepSeek Harness.**
