# Changelog

All notable changes to PipelineDoc will be documented here.

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
