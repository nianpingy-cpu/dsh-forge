# DSH Forge

DSH Forge 是一组面向 DeepSeek Harness 的开发者工具插件。它把成熟的 CLI 工具封装成类型安全、权限可控、结果结构化的 Agent Tools，让智能体可以调用真实的开发工具完成检查、修复、验证与自动化执行，而不是直接拼 Shell 命令。

```text
Understand → Search → Modify → Lint/Format → Test/CI → Security → Container/Perf → Verify
```

DSH Forge 提供的是开发者工具与 DeepSeek Harness 之间的一层适配层（Adapter Layer），核心目标是把工具调用约束在类型化参数、工作区边界与权限模型之内。

---

## Current Status

**Current release: `v1.0.0`**

- 12 个核心插件
- 1 个统一 Core SDK
- 1 套 Quality & Security Gate
- 7 个 Presets
- 500+ automated tests
- Ubuntu / Windows CI
- DeepSeek Harness compatibility matrix
- Supply-chain / release hardening
- GitHub Releases: v0.1.0 / v0.2.0 / v0.3.0 / v1.0.0

---

# Plugin Ecosystem

## 1. ast-grep — Structural Code Search & Rewrite

基于 AST 的代码搜索与批量改写，支持 JS/TS/JSX/TSX/Python。

能力：结构化搜索、规则检查、批量 Rewrite、API Migration、重构。

## 2. Ruff — Python Quality

Python 代码质量检查与格式化。

工具：`ruff_check`、`ruff_format_check`、`ruff_explain`、`ruff_fix`、`ruff_format`。

## 3. Biome — Web / JS / TS Quality

面向 JavaScript / TypeScript / JSX / TSX / JSON 的 Lint 与 Format。

工具：`biome_check`、`biome_lint`、`biome_format_check`、`biome_fix`、`biome_format`。

## 4. uv — Python Environment & Dependency Management

Python 环境与依赖管理。

能力：依赖同步、依赖树查看、添加/移除依赖、运行命令、项目环境管理。

## 5. act — Local GitHub Actions

在本地执行 GitHub Actions 工作流。

能力：Workflow/Job 发现、本地运行、失败状态与 CI 结果分析。

## 6. Semgrep — Source Code Security

源码级静态安全分析，输出结构化 findings。

工具：`semgrep_scan`、`semgrep_scan_file`、`semgrep_ruleset`、`semgrep_security_scan`。

## 7. Trivy — Supply Chain & Container Security

供应链与容器安全：文件系统、镜像、IaC/配置、密钥、漏洞与 SBOM。

工具：`trivy_repo_scan`、`trivy_config_scan`、`trivy_secret_scan`、`trivy_image_scan`、`trivy_sbom`。

## 8. Quality & Security Gate

把 Ruff / Biome / Semgrep / Trivy 组合成一个统一检查流程，输出 `PASS` / `PASS_WITH_WARNINGS` / `FAIL`，让 Agent 快速判断项目是否达到质量门槛。工具：`quality_gate`、`quality_gate_status`。

## 9. Docker — Container Operations

类型化、权限可控的 Docker 操作。读取：status/containers/images/logs/inspect/compose status；受控写：build、compose up/down。高风险操作不会暴露为任意 Shell。

## 10. k6 — Performance & Load Testing

性能与负载测试。工具：`k6_version`、`k6_run`、`k6_smoke`、`k6_load`、`k6_stress`、`k6_summary`、`k6_threshold_check`。

## 11. FFmpeg — Media Operations

把 FFmpeg 命令封装成高层类型化操作：probe、clip、transcode、concat、audio、thumbnail、compress，而不是让模型拼接任意 FFmpeg Shell 命令。

## 12. Vision — 识图、数据分析与图表

面向开发者的图像与数据分析工具：检查 UI 截图并返回结构化的尺寸、对比度与配色诊断；分析客户发来的简单 CSV/JSON 数据；生成 SVG 图表写入工作区。工具：`vision_inspect`、`data_analyze`、`chart_generate`。

---

# Presets

避免逐个配置插件，DSH Forge 提供组合式 Presets：

| Preset | 插件 | 适用 |
|---|---|---|
| coding | ast-grep, Ruff, Biome | 一般开发与重构 |
| python | Ruff, uv | Python 项目 |
| web | Biome, ast-grep | JS/TS 项目 |
| security | Semgrep, Trivy, Quality Gate | 安全扫描与门禁 |
| devops | act, Docker, k6 | CI/CD、容器与性能 |
| media | FFmpeg | 多媒体 |
| full | 全部插件 | 完整工具生态 |

---

# Safety by Design

DSH Forge 的目标是让工具以更受控的方式被调用，而不是执行更多命令。

## Typed Arguments

参数经过显式 Schema 验证，避免 `command: "some arbitrary shell..."` 这类自由字符串：

```text
tool({ file, rule, options })
```

## No Arbitrary Shell

默认采用 `binary + argv[]`，而不是 `shell=true`，避免把任意 Shell 权限直接交给 Agent。

## Workspace Boundary

写操作默认限制在当前 Workspace 内，阻止 `../` 路径穿越、绝对路径逃逸与符号链接逃逸。

## Mutation Classification

工具按副作用分类：`read` / `workspace-write` / `network` / `process` / `system-change` / `destructive`，为权限系统提供明确语义。

---

# Structured Results

DSH Forge 将工具结果归一化为结构化诊断，而不是让 Agent 从大段终端文本中猜测：

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

Agent 可以直接读到问题类型、文件、行号、严重程度与是否可自动修复。

---

# Engineering Quality

开发遵循 Issue-driven + TDD 流程：Issue → TDD RED → GREEN → Refactor → PR → CI → Review → Merge。

工程质量信号：500+ tests、TypeScript typecheck、Lint/Build 验证、Ubuntu/Windows CI、确定性 E2E、插件契约测试、真实工具集成测试、独立外部模型评审、版本化 GitHub Releases。

---

# Architecture

```text
DeepSeek Harness
      ↓ Typed Tools
      ┌───────────┐
      │ DSH Forge │
      └───────────┘
    ├ Argument Validation ├ Permission Policy ├ Workspace Boundary ┤
      ↓ Safe Adapter
      ast-grep · Ruff · Biome · uv · act · Semgrep · Trivy · Docker · k6 · FFmpeg · Vision
      ↓ Structured Result
      Reason / Fix / Verify
```

---

# Roadmap

## v0.1.0

Core SDK · ast-grep · Ruff · Biome · Basic presets · E2E foundation

## v0.2.0

uv · act · Semgrep · Trivy · Quality & Security Gate · Security/DevOps presets

## v0.3.0

Docker · k6 · FFmpeg · Full preset system · Full E2E stories

## v1.0.0

DeepSeek Harness compatibility matrix · Per-plugin documentation + examples · Supply-chain/release hardening · Stable public contracts

---

# Contributing

Contributions are welcome. Before contributing, please read:

- `CONTRIBUTING.md`
- `AGENTS.md`
- `SECURITY.md`
- `docs/ARCHITECTURE.md`
- `docs/PLUGIN_STANDARD.md`

---

# License

MIT. Third-party tools remain governed by their respective upstream licenses. DSH Forge is an adapter layer and does not treat upstream tools as reimplemented project code.
