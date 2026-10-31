# Changelog

All notable changes to PipelineDoc will be documented here.

## [Unreleased]

### Added

- **Model selection:** choose which OpenAI (`pipelineDoc.openaiModel`) or Anthropic (`pipelineDoc.anthropicModel`) model to use for generation, instead of a hardcoded model. Accepts any valid model ID, with common models suggested in Settings.
- **Batch Generation (Premium):** right-click a folder in Explorer to generate documentation for every `.item`/`.json` pipeline inside it (recursively), written to a mirrored `pipeline-docs/` folder alongside a deterministic `README.md` project index.
- Adaptive concurrency with automatic rate-limit (429) backoff and retry during Batch Generation, configurable via `pipelineDoc.batchConcurrency` (default: 5)
- `pipelineDoc.tier` setting as a temporary local flag to unlock Premium features ahead of real license validation

## [0.1.1] — 2026-06-21

### Fixed

- Activity Bar panel now activates correctly on startup

## [0.1.0] — 2026-06-21

### Added

- Generate AI-powered documentation from Talend `.item` files
- Generate AI-powered documentation from Azure Data Factory (ADF) pipeline JSON
- Generate AI-powered documentation from Microsoft Fabric Data Pipeline JSON
- ARM template format support for ADF pipelines
- Automatic Mermaid architecture diagram (deterministic, no AI required)
- Documentation sections: Purpose, Data Flow, Source & Target Systems, Transformations, Data Lineage, Impact Analysis, Risks, Operations & Error Handling
- Secure API key storage via VS Code SecretStorage (Windows Credential Manager / macOS Keychain)
- Timestamped output files — previous documentation is never overwritten
- Activity Bar panel with Account info, Settings shortcuts, and Recent Documents
- English and Swedish output language support
- One-time privacy notice informing users about AI data processing
- Support for OpenAI (`gpt-4o-mini`) and Anthropic (`claude-sonnet-4-6`) providers
- Premium provider placeholder for hosted backend (coming soon)
