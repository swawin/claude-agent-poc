import Anthropic from '@anthropic-ai/sdk';
import { validateDynamicCsvResult, getInputRowCount } from './dynamicValidation.js';

const MAX_EXECUTION_ATTEMPTS = 2;
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_RAW_EXCERPT = 700;
const CSV_DEBUG_PREVIEW_LENGTH = 200;


function extractTextBlocks(content) {
  return content
    .filter((block) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function extractCodeBlocks(text = '') {
  const matches = text.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g);
  if (!matches?.length) return '';
  return matches
    .map((match) => match.replace(/```(?:[a-zA-Z0-9_-]+)?\n?|```/g, '').trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 1200);
}

function extractPlanText(text = '') {
  const planSection = text.match(/(?:^|\n)(?:plan|steps?)\s*:\s*([\s\S]{0,1500})/i);
  if (planSection?.[1]) return planSection[1].trim().split('\n\n')[0].slice(0, 1200);
  return '';
}

function parseJsonObject(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    throw new Error('Claude did not return any JSON content.');
  }

  const stripped = normalized
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch {
    // Continue to first valid JSON-object extraction.
  }

  const start = stripped.indexOf('{');
  if (start === -1) {
    throw new Error('Claude did not return a JSON object.');
  }

  for (let i = start; i < stripped.length; i += 1) {
    if (stripped[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < stripped.length; j += 1) {
      const ch = stripped[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth === 0) {
        const candidate = stripped.slice(i, j + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          break;
        }
      }
    }
  }

  throw new Error('Claude did not return parseable JSON.');
}

function pickFinalPayloadShape(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return {};
  if (candidate.cleaned_csv || candidate.summary || candidate.metadata) return candidate;
  const nestedCandidates = [candidate.result, candidate.final_result, candidate.output, candidate.payload];
  for (const nested of nestedCandidates) {
    if (nested && typeof nested === 'object' && (nested.cleaned_csv || nested.summary || nested.metadata)) {
      return nested;
    }
  }
  return candidate;
}

function sanitizeRawExcerpt(value = '') {
  const redacted = String(value)
    .replace(/(sk-[a-zA-Z0-9-_]+)/g, '[REDACTED_KEY]')
    .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]+/gi, '$1[REDACTED]')
    .trim();
  return redacted.slice(0, MAX_RAW_EXCERPT);
}

function collectRawContentTypes(content = []) {
  return Array.from(new Set(content.map((block) => block?.type).filter(Boolean)));
}

function hasToolUse(content = []) {
  return content.some((block) => block?.type === 'tool_use' || block?.type === 'server_tool_use');
}

function hasToolResult(content = []) {
  return content.some((block) =>
    block?.type === 'tool_result' ||
    block?.type === 'code_execution_tool_result' ||
    block?.type === 'web_search_tool_result'
  );
}

function countByTypes(content = [], types = []) {
  return content.filter((block) => types.includes(block?.type)).length;
}

function normalizePayload(candidate = {}) {
  const selected = pickFinalPayloadShape(candidate);
  const metadata = selected.metadata && typeof selected.metadata === 'object' ? selected.metadata : {};
  return {
    plan: typeof selected.plan === 'string' ? selected.plan : '',
    summary: typeof selected.summary === 'string' ? selected.summary : '',
    cleaned_csv: typeof selected.cleaned_csv === 'string' ? selected.cleaned_csv : '',
    generated_code_excerpt:
      typeof selected.generated_code_excerpt === 'string' ? selected.generated_code_excerpt : '',
    warnings: Array.isArray(selected.warnings) ? selected.warnings.map(String) : [],
    validation_notes: Array.isArray(selected.validation_notes)
      ? selected.validation_notes.map(String)
      : [],
    per_user_summary:
      selected.per_user_summary && typeof selected.per_user_summary === 'object'
        ? selected.per_user_summary
        : null,
    anomalies: Array.isArray(selected.anomalies) ? selected.anomalies : [],
    metadata: {
      rows_input: Number.isFinite(metadata.rows_input) ? Number(metadata.rows_input) : null,
      rows_output: Number.isFinite(metadata.rows_output) ? Number(metadata.rows_output) : null,
      duplicates_removed: Number.isFinite(metadata.duplicates_removed) ? Number(metadata.duplicates_removed) : null,
      dates_normalized: Number.isFinite(metadata.dates_normalized) ? Number(metadata.dates_normalized) : null,
      validation_passed: typeof metadata.validation_passed === 'boolean' ? metadata.validation_passed : null
    }
  };
}

function buildSystemPrompt() {
  return [
    'You are a bounded dynamic CSV execution agent.',
    'Inspect inline CSV text, create a plan, write transformation code, execute it with the code execution tool, inspect output, then return final JSON.',
    'You MUST use the code execution tool before finalizing when CSV is provided.',
    'The CSV is provided inline in the user message and is the only source of truth.',
    'You MUST use the provided CSV content above and MUST NOT claim it is missing.',
    'Do NOT assume external files exist in the runtime.',
    'Do NOT use pd.read_csv("data.csv") or any filename-based CSV loading.',
    'Load the CSV from the provided csv_text variable with from io import StringIO and pandas.read_csv(StringIO(csv_text)).',
    'Do NOT read files like data.csv or any other placeholder/local filename.',
    'Do not describe what you would do. Do not return generic templates.',
    'Do not fabricate successful execution. If execution fails, explain and retry with revised code.',
    'Preserve uncertain/invalid values and provide warnings instead of silently forcing a fix.',
    'After any tool-use content, always end with one strict JSON object and no extra text.',
    'Required JSON keys:',
    '{',
    '  "plan": "string",',
    '  "summary": "string",',
    '  "cleaned_csv": "string",',
    '  "generated_code_excerpt": "string",',
    '  "warnings": ["string"],',
    '  "validation_notes": ["string"],',
    '  "per_user_summary": {"optional": "object if requested, else {}"},',
    '  "anomalies": ["optional anomaly descriptions if requested, else []"]',
    '}'
  ].join('\n');
}

function buildFinalizationInstruction() {
  return [
    'You have already analyzed and executed code on the provided CSV content.',
    'Now return ONLY a strict JSON object with the final computed results.',
    'Do not include prose, markdown, or code fences.',
    'The JSON must contain:',
    '- cleaned_csv',
    '- summary',
    '- warnings',
    '- metadata',
    'If cleaned_csv is empty, the response is invalid.',
    'Required shape:',
    '{',
    '  "cleaned_csv": "<non-empty csv text>",',
    '  "summary": "<grounded summary>",',
    '  "warnings": [],',
    '  "metadata": {',
    '    "rows_input": number,',
    '    "rows_output": number,',
    '    "duplicates_removed": number,',
    '    "dates_normalized": number,',
    '    "validation_passed": boolean',
    '  }',
    '}'
  ].join('\n');
}

function buildUserPrompt({
  task,
  csvText,
  iteration,
  maxIterations,
  priorFailures,
  priorOutput,
  correctionMessage
}) {
  const escapedCsvForPython = JSON.stringify(csvText);
  const sections = [
    `Task: ${task || 'Clean and normalize this CSV.'}`,
    `Iteration: ${iteration} of ${maxIterations}`,
    'Here is the CSV content:',
    '<CSV>',
    csvText,
    '</CSV>',
    '',
    'Use this exact variable in your execution code:',
    `csv_text = ${escapedCsvForPython}`,
    '',
    'Important execution rules:',
    '- You MUST use the provided CSV content above.',
    '- Do NOT assume external files.',
    '- Do NOT use pd.read_csv("data.csv") or any filename.',
    '- Instead use: from io import StringIO ; df = pd.read_csv(StringIO(csv_text))',
    '- csv_text must come from the provided content.'
  ];

  if (priorOutput) {
    sections.push('', 'Previous candidate cleaned CSV:', priorOutput);
  }

  if (priorFailures?.length) {
    sections.push('', 'Validation failures from backend that must be fixed:', ...priorFailures.map((f) => `- ${f}`));
  }
  if (correctionMessage) {
    sections.push('', 'Correction instructions (must follow exactly):', correctionMessage);
  }

  sections.push(
    '',
    'Requirements:',
    '- Analyze structure and provide a concise plan.',
    '- Write executable Python code and execute it with the code execution tool.',
    '- Build DataFrame from the provided inline CSV string, not from a filename.',
    '- Do not use placeholder filenames such as data.csv.',
    '- If execution succeeds, return actual computed results.',
    '- Return cleaned CSV with headers and data rows.',
    '- If task asks for deduplication/date normalization/missing value handling, satisfy that behavior.',
    '- Keep CSV valid and parseable.',
    '- Final answer must be a strict JSON object with required keys after any tool output.'
  );

  return sections.join('\n');
}

async function tryFormattingRepair({ anthropic, model, textToRepair, debug }) {
  if (!textToRepair) return null;

  try {
    const repair = await anthropic.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 1200,
      temperature: 0,
      system:
        'Return only valid JSON. No prose. No markdown. No code fences.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Repair this into strict JSON using this shape: {"cleaned_csv":"","summary":"","warnings":[],"metadata":{"rows_input":0,"rows_output":0,"duplicates_removed":0,"dates_normalized":0,"validation_passed":false}}\n\n${textToRepair}`
            }
          ]
        }
      ]
    });

    const repairText = extractTextBlocks(Array.isArray(repair.content) ? repair.content : []);
    debug.raw_stop_reason = typeof repair?.stop_reason === 'string' ? repair.stop_reason : debug.raw_stop_reason;
    if (repairText) {
      debug.raw_response_excerpt = sanitizeRawExcerpt(repairText);
      return normalizePayload(parseJsonObject(repairText));
    }
    return null;
  } catch (error) {
    debug.parser_error = `Formatting-repair retry failed: ${error?.message || 'Unknown error'}`;
    return null;
  }
}

function buildAdvisoryResponse(task = '') {
  return {
    result: [
      'Dynamic execution mode is enabled, but this demo requires an uploaded CSV file.',
      '',
      `Task received: ${task || '(none provided)'}`,
      'Please upload a CSV file and retry dynamic execution.'
    ].join('\n'),
    logs: [
      'Dynamic mode selected.',
      'No CSV file found in request.',
      'Returning advisory response for experimental dynamic execution path.'
    ],
    metadata: {
      execution_mode: 'dynamic_agent_execution',
      rows_input: 0,
      rows_output: 0,
      duplicates_removed: null,
      dates_normalized: null,
      validation_passed: false,
      iterations_used: 0,
      warnings: ['Dynamic execution requires an uploaded CSV file for this demo.'],
      dynamic_code_used: false
    },
    artifacts: {
      plan: 'Upload CSV -> plan -> generate code -> execute in Anthropic sandbox -> validate -> retry if needed.'
    }
  };
}

function detectPlaceholderFileAccess(text = '') {
  if (!text) return false;
  return /(?:pd|pandas)\.read_csv\(\s*["'][^"']+\.csv["']\s*\)/i.test(text);
}

function detectMissingCsvClaim(text = '') {
  if (!text) return false;
  return /(no csv data was provided|no csv (?:was )?provided|csv (?:content|data) (?:is )?missing|missing csv data)/i.test(
    text
  );
}

function isGenericSummary(summary = '', rowsInput = 0, rowsOutput = 0) {
  if (!summary?.trim()) return true;
  const normalized = summary.toLowerCase();
  if (/no specific csv file was provided/.test(normalized)) return true;
  const mentionsInput = rowsInput > 0 ? normalized.includes(String(rowsInput)) : false;
  const mentionsOutput = rowsOutput > 0 ? normalized.includes(String(rowsOutput)) : false;
  const hasNumbers = /\b\d+\b/.test(normalized);
  return !(mentionsInput || mentionsOutput || hasNumbers);
}

export async function executeDynamicCsvTask({ task, csvText, fileBuffer, apiKey, model }) {
  const taskText = (task || '').trim();
  const resolvedCsvText =
    typeof csvText === 'string' ? csvText : fileBuffer ? fileBuffer.toString('utf-8') : '';

  if (!resolvedCsvText.trim()) {
    return buildAdvisoryResponse(taskText);
  }

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured. Dynamic execution requires Anthropic tool use.');
  }

  const logs = [
    'Uploading CSV into dynamic execution context...',
    'Analyzing uploaded CSV and task requirements...',
    'Preparing dynamic execution plan...'
  ];

  const anthropic = new Anthropic({ apiKey });
  const allWarnings = [];
  const anthropicTools = [
    {
      type: 'code_execution_20250522',
      name: 'code_execution'
    }
  ];

  const debug = {
    anthropic_tools_sent: anthropicTools.map((tool) => tool.type || tool.name).filter(Boolean),
    tool_use_detected: false,
    tool_result_detected: false,
    tool_use_count: 0,
    tool_result_count: 0,
    raw_stop_reason: null,
    raw_content_types: [],
    raw_response_excerpt: '',
    parser_stage_reached: '',
    parser_error: null,
    csv_inline_provided: true,
    csv_chars_length: resolvedCsvText.length,
    csv_preview: resolvedCsvText.slice(0, CSV_DEBUG_PREVIEW_LENGTH),
    placeholder_file_access_detected: false,
    missing_csv_claim_detected: false,
    cleaned_csv_empty: false,
    server_tool_use_detected: false,
    finalization_call_made: false,
    final_json_detected: false,
    cleaned_csv_header_detected: false,
    cleaned_csv_row_count: 0,
    outcome: 'execution_not_completed'
  };

  let finalPayload = null;
  let finalText = '';
  let validation = null;
  let iterationsUsed = 0;
  let codeToolUsed = false;
  let fallbackArtifacts = { plan: '', generated_code: '' };
  let correctionMessage = '';

  for (let iteration = 1; iteration <= MAX_EXECUTION_ATTEMPTS; iteration += 1) {
    iterationsUsed = iteration;
    logs.push(`Generating transformation code (iteration ${iteration}/${MAX_EXECUTION_ATTEMPTS})...`);
    logs.push('Executing code in Anthropic sandbox...');

    let message;
    const conversation = [
      {
        role: 'user',
        content: buildUserPrompt({
          task: taskText,
          csvText: resolvedCsvText,
          iteration,
          maxIterations: MAX_EXECUTION_ATTEMPTS,
          priorFailures: validation?.failures,
          priorOutput: finalPayload?.cleaned_csv,
          correctionMessage
        })
      }
    ];
    try {
      message = await anthropic.messages.create({
        model: model || DEFAULT_MODEL,
        max_tokens: 1800,
        temperature: 0,
        system: buildSystemPrompt(),
        tools: anthropicTools,
        messages: conversation
      });
      debug.parser_stage_reached = 'received_response';
    } catch (error) {
      const details = error?.message || 'Unknown Anthropic error';
      throw new Error(`Dynamic Claude execution failed: ${details}`);
    }

    const content = Array.isArray(message.content) ? message.content : [];
    debug.raw_content_types = Array.from(new Set([...debug.raw_content_types, ...collectRawContentTypes(content)]));
    const toolUseCount = countByTypes(content, ['tool_use', 'server_tool_use']);
    const toolResultCount = countByTypes(content, [
      'tool_result',
      'code_execution_tool_result',
      'web_search_tool_result'
    ]);
    debug.tool_use_count += toolUseCount;
    debug.tool_result_count += toolResultCount;
    debug.tool_use_detected = debug.tool_use_detected || hasToolUse(content);
    debug.server_tool_use_detected =
      debug.server_tool_use_detected || content.some((block) => block?.type === 'server_tool_use');
    debug.tool_result_detected = debug.tool_result_detected || hasToolResult(content);
    if (debug.tool_use_detected) debug.parser_stage_reached = 'detected_tool_use';
    if (debug.tool_result_detected) debug.parser_stage_reached = 'detected_tool_result';

    if (typeof message?.stop_reason === 'string') {
      debug.raw_stop_reason = message.stop_reason;
    }

    if (debug.tool_use_detected || debug.tool_result_detected) {
      codeToolUsed = true;
    }

    const responseText = extractTextBlocks(content);
    if (!responseText) {
      logs.push('Claude returned no text payload; retrying...');
      continue;
    }

    finalText = responseText;
    debug.raw_response_excerpt = sanitizeRawExcerpt(responseText);
    debug.parser_stage_reached = 'parsed_final_text';

    fallbackArtifacts = {
      plan: extractPlanText(responseText),
      generated_code: extractCodeBlocks(responseText)
    };

    let candidatePayload = null;
    let parsedFirstPass = false;
    try {
      candidatePayload = normalizePayload(parseJsonObject(responseText));
      parsedFirstPass = true;
    } catch (error) {
      debug.parser_error = error.message;
    }

    const hasExecutionEvidence = debug.tool_use_detected || debug.tool_result_detected;
    const firstPassMissingFinalJson =
      !parsedFirstPass || !candidatePayload?.cleaned_csv || !candidatePayload?.summary;

    if (hasExecutionEvidence && firstPassMissingFinalJson) {
      logs.push('Execution detected; issuing finalization call for strict JSON result...');
      debug.finalization_call_made = true;
      const finalizationPrompt = buildFinalizationInstruction();
      let finalizationResponse;
      try {
        finalizationResponse = await anthropic.messages.create({
          model: model || DEFAULT_MODEL,
          max_tokens: 1400,
          temperature: 0,
          system: buildSystemPrompt(),
          tools: anthropicTools,
          messages: [
            ...conversation,
            { role: 'assistant', content },
            { role: 'user', content: finalizationPrompt }
          ]
        });
      } catch (error) {
        debug.parser_error = `Finalization call failed: ${error?.message || 'Unknown error'}`;
      }

      const finalizationContent = Array.isArray(finalizationResponse?.content)
        ? finalizationResponse.content
        : [];
      if (finalizationContent.length) {
        debug.raw_content_types = Array.from(
          new Set([...debug.raw_content_types, ...collectRawContentTypes(finalizationContent)])
        );
        const finalizationText = extractTextBlocks(finalizationContent);
        if (finalizationText) {
          finalText = finalizationText;
          debug.raw_response_excerpt = sanitizeRawExcerpt(finalizationText);
          try {
            candidatePayload = normalizePayload(parseJsonObject(finalizationText));
            parsedFirstPass = true;
            debug.final_json_detected = true;
          } catch (error) {
            debug.parser_error = `Finalization parse failed: ${error?.message || 'Unknown parse error'}`;
          }
        }
      }
    } else if (parsedFirstPass) {
      debug.final_json_detected = true;
    }

    if (!parsedFirstPass || !candidatePayload) {
      logs.push(`Claude returned unstructured text on iteration ${iteration}; attempting fallback handling...`);
      allWarnings.push('Claude response was not strict JSON; building partial dynamic response.');
      continue;
    }

    debug.parser_stage_reached = 'parsed_structured_json';
    finalPayload = candidatePayload;

    if (!finalPayload.cleaned_csv) {
      debug.cleaned_csv_empty = true;
      logs.push(`Candidate output missing cleaned_csv on iteration ${iteration}; retrying...`);
      allWarnings.push('Claude response missing cleaned_csv field.');
      correctionMessage =
        'You must use the inline CSV content already provided. Do not use external filenames. Return actual cleaned CSV text and structured JSON only.';
      continue;
    }

    const missingCsvClaimDetected = detectMissingCsvClaim(
      [
        responseText,
        finalPayload.summary,
        ...(finalPayload.validation_notes || []),
        ...(finalPayload.warnings || [])
      ]
        .filter(Boolean)
        .join('\n')
    );
    debug.missing_csv_claim_detected = debug.missing_csv_claim_detected || missingCsvClaimDetected;
    if (missingCsvClaimDetected) {
      validation = {
        passed: false,
        warnings: [],
        failures: ['Claude claimed CSV was not provided even though CSV content was injected.'],
        rows_input: getInputRowCount(resolvedCsvText),
        rows_output: 0,
        duplicates_removed: null,
        dates_normalized: null
      };
      logs.push('Validation failed: Claude claimed CSV was missing. Retrying with stronger grounding...');
      correctionMessage =
        'You were already given CSV content. You must use it. Do not claim CSV is missing. Use csv_text and StringIO(csv_text) only.';
      continue;
    }

    const placeholderDetected = detectPlaceholderFileAccess(
      [finalPayload.generated_code_excerpt, fallbackArtifacts.generated_code, responseText].filter(Boolean).join('\n')
    );
    debug.placeholder_file_access_detected = debug.placeholder_file_access_detected || placeholderDetected;
    if (placeholderDetected) {
      validation = {
        passed: false,
        warnings: [],
        failures: ['Generated code uses placeholder file access (e.g., data.csv).'],
        rows_input: getInputRowCount(resolvedCsvText),
        rows_output: 0,
        duplicates_removed: null,
        dates_normalized: null
      };
      logs.push('Validation failed: placeholder file access detected. Retrying with correction instructions...');
      correctionMessage =
        'You were already given CSV content. You must use it. Do not use external filenames. Use csv_text and StringIO(csv_text) only.';
      continue;
    }

    logs.push('Inspecting generated output...');
    validation = validateDynamicCsvResult({
      task: taskText,
      inputCsv: resolvedCsvText,
      outputCsv: finalPayload.cleaned_csv
    });

    allWarnings.push(...finalPayload.warnings);
    allWarnings.push(...validation.warnings);

    const genericSummary = isGenericSummary(
      finalPayload.summary,
      validation.rows_input ?? getInputRowCount(resolvedCsvText),
      validation.rows_output ?? 0
    );
    if (genericSummary) {
      validation.failures.push('Summary appears generic or ungrounded in actual row counts.');
    }
    validation.passed = validation.failures.length === 0;

    if (validation.passed) {
      logs.push('Validation passed. Preparing final response...');
      break;
    }

    logs.push(`Validation failed: ${validation.failures.join(' ')} Retrying...`);
    correctionMessage = 'Return only valid JSON. No prose. No markdown. No code fences.';
  }

  if (!finalPayload && finalText) {
    logs.push('Attempting one formatting-repair retry for invalid structured output...');
    const repairedPayload = await tryFormattingRepair({
      anthropic,
      model,
      textToRepair: finalText,
      debug
    });

    if (repairedPayload) {
      finalPayload = repairedPayload;
      debug.parser_stage_reached = 'parsed_structured_json';
      allWarnings.push('Structured payload recovered via formatting-repair retry.');
    }
  }

  let executionMode = 'dynamic_agent_execution';

  if (!finalPayload) {
    debug.parser_stage_reached = 'built_fallback_response';
    const partialWarnings = [
      ...allWarnings,
      'Dynamic response was partial/unstructured. Returning best-effort result.'
    ];

    const partialResult = finalText || 'No usable final text returned by Claude.';
    const inputRows = getInputRowCount(resolvedCsvText);

    if (!partialResult && !fallbackArtifacts.plan && !fallbackArtifacts.generated_code) {
      throw new Error('Claude failed to produce any usable response content.');
    }

    executionMode = 'dynamic_agent_execution_partial';
    debug.outcome = codeToolUsed
      ? 'execution_succeeded_final_formatting_failed'
      : 'execution_failed';

    console.log('[execute-dynamic] parser_stage_reached:', debug.parser_stage_reached);
    console.log('[execute-dynamic] raw_content_types:', debug.raw_content_types);
    console.log('[execute-dynamic] parser_error:', debug.parser_error);
    console.log('[execute-dynamic] tool_use_detected:', debug.tool_use_detected);
    console.log('[execute-dynamic] tool_result_detected:', debug.tool_result_detected);

    return {
      result: partialResult,
      logs,
      metadata: {
        execution_mode: executionMode,
        rows_input: inputRows,
        rows_output: 0,
        duplicates_removed: null,
        dates_normalized: null,
        validation_passed: false,
        iterations_used: iterationsUsed,
        warnings: Array.from(new Set(partialWarnings.filter(Boolean))),
        dynamic_code_used: codeToolUsed
      },
      artifacts: {
        generated_code: fallbackArtifacts.generated_code || undefined,
        plan: fallbackArtifacts.plan || undefined
      },
      debug
    };
  }

  if (!validation) {
    validation = validateDynamicCsvResult({
      task: taskText,
      inputCsv: resolvedCsvText,
      outputCsv: finalPayload.cleaned_csv || ''
    });
    allWarnings.push(...validation.warnings);
    allWarnings.push(...finalPayload.warnings);
    allWarnings.push(...finalPayload.validation_notes);
  }

  const cleanedCsvText = (finalPayload.cleaned_csv || '').trim();
  debug.cleaned_csv_empty = !cleanedCsvText;
  const csvLines = cleanedCsvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  debug.cleaned_csv_header_detected = csvLines.length > 0;
  debug.cleaned_csv_row_count = Math.max(csvLines.length - 1, 0);
  if (typeof validation.cleaned_csv_header_detected === 'boolean') {
    debug.cleaned_csv_header_detected = validation.cleaned_csv_header_detected;
  }
  if (typeof validation.rows_output === 'number') {
    debug.cleaned_csv_row_count = validation.rows_output;
  }
  debug.final_json_detected = debug.final_json_detected || Boolean(finalPayload.cleaned_csv || finalPayload.summary);
  const summary = finalPayload.summary ? `Summary:\n${finalPayload.summary}` : 'Summary:\nNo summary returned.';
  const result = `${cleanedCsvText}\n\n${summary}`.trim();

  if (!codeToolUsed) {
    allWarnings.push('No explicit code-execution tool output detected; verify Anthropic tool availability.');
  }
  debug.outcome = codeToolUsed
    ? debug.final_json_detected
      ? 'final_json_succeeded'
      : 'execution_succeeded_final_formatting_failed'
    : 'execution_failed';

  const inputRows = validation.rows_input ?? getInputRowCount(resolvedCsvText);

  console.log('[execute-dynamic] parser_stage_reached:', debug.parser_stage_reached);
  console.log('[execute-dynamic] raw_content_types:', debug.raw_content_types);
  console.log('[execute-dynamic] parser_error:', debug.parser_error);
  console.log('[execute-dynamic] tool_use_detected:', debug.tool_use_detected);
  console.log('[execute-dynamic] tool_result_detected:', debug.tool_result_detected);

  return {
    result,
    logs,
    metadata: {
      execution_mode: executionMode,
      rows_input: inputRows,
      rows_output: validation.rows_output ?? 0,
      duplicates_removed: finalPayload.metadata.duplicates_removed ?? validation.duplicates_removed,
      dates_normalized: finalPayload.metadata.dates_normalized ?? validation.dates_normalized,
      validation_passed: validation.passed,
      iterations_used: iterationsUsed,
      warnings: Array.from(new Set(allWarnings.filter(Boolean))),
      dynamic_code_used: codeToolUsed
    },
    artifacts: {
      cleaned_csv: cleanedCsvText || undefined,
      anomalies: finalPayload.anomalies?.length ? finalPayload.anomalies : undefined,
      per_user_summary: finalPayload.per_user_summary || undefined,
      generated_code: finalPayload.generated_code_excerpt
        ? String(finalPayload.generated_code_excerpt).slice(0, 1200)
        : fallbackArtifacts.generated_code || undefined,
      plan: finalPayload.plan || fallbackArtifacts.plan || undefined
    },
    debug
  };
}
