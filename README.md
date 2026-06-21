# PipelineDoc

**AI-powered documentation for ETL pipelines — in seconds.**

PipelineDoc reads your pipeline files and generates complete, professional Markdown documentation using AI. Supports Talend, Azure Data Factory (ADF), and Microsoft Fabric Data Pipelines.

---

## Features

- **Architecture diagram** — auto-generated Mermaid flowchart rendered directly in the preview
- **Full documentation** — Purpose, Data Flow, Source & Target Systems, Transformations, Data Lineage, Impact Analysis, Risks, Operations
- **Multi-format support** — Talend `.item` files, ADF pipeline JSON, Fabric pipeline JSON, ARM templates
- **Secure API key storage** — keys stored encrypted via the system keychain (Windows Credential Manager / macOS Keychain), never in plain text
- **Timestamped output** — every generation creates a new file, nothing is ever overwritten
- **Language support** — English or Swedish output

---

## Supported Pipeline Formats

| Format             | File type | How to use              |
| ------------------ | --------- | ----------------------- |
| Talend             | `.item`   | Right-click in Explorer |
| Azure Data Factory | `.json`   | Right-click in Explorer |
| Microsoft Fabric   | `.json`   | Right-click in Explorer |
| ARM template       | `.json`   | Right-click in Explorer |

---

## Getting Started

### 1. Set your AI provider

Open the Command Palette (`Ctrl+Shift+P`) and run:

- **`PipelineDoc: Set OpenAI API Key`** — enter your OpenAI API key
- Then open Settings (`Ctrl+,`), search `pipelineDoc`, and set **AI Provider** to `openai`

> **Premium users:** set the provider to `premium` and enter your license key — no personal API key required.

### 2. Generate documentation

Right-click any supported pipeline file in the Explorer panel and select:

- **PipelineDoc: Generate Documentation from .item file** (Talend)
- **PipelineDoc: Generate Documentation from ADF / Fabric / Talend JSON**

The rendered documentation opens automatically in Markdown Preview.

---

## Output Example

Each generated document includes:

```
# MyPipeline

## Architecture Overview
[Mermaid flowchart]

## Purpose
## Data Flow
## Source Systems
## Target Systems
## Transformations
## Data Lineage
## Impact Analysis
## Risks
## Operations & Error Handling
```

Files are saved next to the source file with a timestamp:
`MyPipeline_doc_2026-06-21_14-30-00.md`

---

## Settings

| Setting                      | Description                        | Default   |
| ---------------------------- | ---------------------------------- | --------- |
| `pipelineDoc.aiProvider`     | `openai` / `anthropic` / `premium` | `premium` |
| `pipelineDoc.outputLanguage` | `english` / `svenska`              | `english` |

API keys are managed securely via the Command Palette — not stored in settings.

---

## Requirements

- VS Code 1.85 or later
- An OpenAI or Anthropic API key (Freemium), or a PipelineDoc Premium license key

---

## Privacy & Security

- Pipeline data is sent to your chosen AI provider (OpenAI or Anthropic) for documentation generation
- API keys are stored encrypted using VS Code's built-in Secret Storage (system keychain)
- No data is stored by xHolst

---

## License

MIT © [Charlotte Holst / xHolst](https://github.com/CharlotteH86)
