/**
 * aiService.ts
 *
 * Skickar strukturerad Talend-jobb-data till ett AI-API och returnerar
 * Markdown-dokumentation.
 *
 * Stödjer tre lägen (konfigureras via VS Code Settings):
 *  - "openai"    – användarens egna OpenAI API-nyckel
 *  - "anthropic" – användarens egna Anthropic API-nyckel (Claude)
 *  - "premium"   – proxas via din backend (Vercel/Supabase), Fas 3
 */

import type { PipelineDocument } from "./parser.js";

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

export type AiProvider = "openai" | "anthropic" | "premium";

export interface AiConfig {
  provider: AiProvider;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  openaiModel?: string;
  anthropicModel?: string;
  premiumApiUrl?: string;
  premiumLicenseKey?: string;
  outputLanguage?: string;
}

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

/**
 * Kastas när AI-leverantören svarar med HTTP 429 (rate limit).
 * Används av Batch Generation för att sakta ner/minska samtidigheten
 * istället för att behandla anropet som ett permanent fel.
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number | undefined,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Läser ut en eventuell `Retry-After`-header (sekunder eller HTTP-datum). */
function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// ---------------------------------------------------------------------------
// Prompt-byggare
// ---------------------------------------------------------------------------

const SECTIONS = [
  "Purpose",
  "Data Flow",
  "Source Systems",
  "Target Systems",
  "Transformations",
  "Data Lineage",
  "Impact Analysis",
  "Risks",
  "Operations & Error Handling",
];

function buildSystemPrompt(
  language: string,
  pipelineType: PipelineDocument["pipeline_type"],
): string {
  const lang = language === "english" ? "English" : "Swedish";
  const toolName =
    pipelineType === "adf"
      ? "Azure Data Factory (ADF)"
      : pipelineType === "fabric"
        ? "Microsoft Fabric Data Pipeline"
        : "Talend";
  return (
    `You are a technical writer specializing in ETL pipeline documentation. ` +
    `You receive structured JSON describing a ${toolName} pipeline job. ` +
    `Generate clear, professional documentation in Markdown format in ${lang}.`
  );
}

function buildUserPrompt(jobData: PipelineDocument, language: string): string {
  const langInstruction =
    language === "english"
      ? "Write the documentation in English."
      : "Write the documentation in Swedish.";

  const isAdfLike =
    jobData.pipeline_type === "adf" || jobData.pipeline_type === "fabric";
  const transformNote = isAdfLike
    ? "- Transformations: describe Copy, Lookup, ForEach, IfCondition and other activities. Note nested activity contexts."
    : "- Transformations: describe tMap and similar components.";
  const riskNote = isAdfLike
    ? "- Risks: identify hardcoded values in expressions, missing retry policies, external dependencies, and activities without dependsOn."
    : "- Risks: identify hardcoded credentials, missing error handling, external dependencies.";

  const sectionList = SECTIONS.map((s) => `- ${s}`).join("\n");
  const jsonStr = JSON.stringify(jobData, null, 2);

  return (
    `${langInstruction}\n\n` +
    `Generate Markdown documentation for the following ETL pipeline job.\n\n` +
    `Include these sections (## heading per section):\n${sectionList}\n\n` +
    `Guidelines:\n` +
    `- Purpose: summarize what the job does and why.\n` +
    `- Data Flow: describe component-to-component flow in order. For ADF/Fabric, use dependsOn relationships.\n` +
    `- Source Systems and Target Systems: list all datasets, linked services, databases, files, and APIs.\n` +
    `${transformNote}\n` +
    `- Data Lineage: trace the end-to-end path of data — from each source, through every transformation step, to each target. Use a table or bullet list per data stream.\n` +
    `- Impact Analysis: for each key field or table identified in the SQL queries and datasets, list which activities depend on it and rate the risk (High/Medium/Low) if it changes. Format as a bullet list per field/table.\n` +
    `${riskNote}\n` +
    `- Operations: what to monitor and how errors are (or should be) handled.\n` +
    `- If information for a section is missing, state that clearly instead of guessing.\n\n` +
    `Job data:\n\`\`\`json\n${jsonStr}\n\`\`\``
  );
}

// ---------------------------------------------------------------------------
// Provider-implementationer
// ---------------------------------------------------------------------------

async function callOpenAI(
  jobData: PipelineDocument,
  config: AiConfig,
): Promise<string> {
  if (!config.openaiApiKey) {
    throw new Error(
      "OpenAI API-nyckel saknas. Ange den i Settings (pipelineDoc.openaiApiKey).",
    );
  }

  const language = config.outputLanguage ?? "svenska";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.openaiModel || DEFAULT_OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(language, jobData.pipeline_type),
        },
        { role: "user", content: buildUserPrompt(jobData, language) },
      ],
    }),
  });

  if (response.status === 429) {
    throw new RateLimitError(
      "OpenAI rate limit (429) nådd.",
      parseRetryAfterMs(response),
    );
  }
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI-anrop misslyckades (${response.status}): ${err}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI-svaret innehöll ingen text.");
  }
  return text;
}

async function callAnthropic(
  jobData: PipelineDocument,
  config: AiConfig,
): Promise<string> {
  if (!config.anthropicApiKey) {
    throw new Error(
      "Anthropic API-nyckel saknas. Ange den i Settings (pipelineDoc.anthropicApiKey).",
    );
  }

  const language = config.outputLanguage ?? "svenska";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt(language, jobData.pipeline_type),
      messages: [{ role: "user", content: buildUserPrompt(jobData, language) }],
    }),
  });

  if (response.status === 429) {
    throw new RateLimitError(
      "Anthropic rate limit (429) nådd.",
      parseRetryAfterMs(response),
    );
  }
  if (!response.ok) {
    const err = await response.text();
    throw new Error(
      `Anthropic-anrop misslyckades (${response.status}): ${err}`,
    );
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text: string }>;
  };
  const text = data.content?.find((b) => b.type === "text")?.text;
  if (!text) {
    throw new Error("Anthropic-svaret innehöll ingen text.");
  }
  return text;
}

async function callPremiumBackend(
  jobData: PipelineDocument,
  config: AiConfig,
): Promise<string> {
  // Platshållare för Fas 3 (Vercel + Supabase-backend)
  // URL och licensnyckel hämtas ur Settings/licens-flödet
  const url =
    config.premiumApiUrl ?? "https://your-app.vercel.app/api/generate";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-license-key": config.premiumLicenseKey ?? "",
    },
    body: JSON.stringify({ jobData }),
  });

  if (response.status === 429) {
    throw new RateLimitError(
      "Premium-backend rate limit (429) nådd.",
      parseRetryAfterMs(response),
    );
  }
  if (!response.ok) {
    const err = await response.text();
    throw new Error(
      `Premium-backend misslyckades (${response.status}): ${err}`,
    );
  }

  const data = (await response.json()) as { documentation?: string };
  if (!data.documentation) {
    throw new Error("Premium-backend returnerade ingen dokumentation.");
  }
  return data.documentation;
}

// ---------------------------------------------------------------------------
// Publik funktion
// ---------------------------------------------------------------------------

/**
 * Genererar Markdown-dokumentation för ett Talend-jobb via valt AI-API.
 *
 * @param jobData - Strukturerad jobb-data från parseTalendItem()
 * @param config  - AI-konfiguration (provider + nycklar)
 * @returns Markdown-sträng med den genererade dokumentationen
 */
export async function generateDocumentation(
  jobData: PipelineDocument,
  config: AiConfig,
): Promise<string> {
  switch (config.provider) {
    case "openai":
      return callOpenAI(jobData, config);
    case "anthropic":
      return callAnthropic(jobData, config);
    case "premium":
      return callPremiumBackend(jobData, config);
    default:
      throw new Error(`Okänd AI-provider: ${config.provider}`);
  }
}
