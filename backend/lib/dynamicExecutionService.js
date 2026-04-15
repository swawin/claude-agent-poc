import Anthropic from '@anthropic-ai/sdk';
import { validateDynamicCsvResult, getInputRowCount } from './dynamicValidation.js';

const MAX_ITERATIONS = 3;
const DEFAULT_MODEL = 'claude-sonnet-4-5';

function extractTextBlocks(content) {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function hasCodeToolSignals(content) {
  return content.some((block) =>
    block.type === 'server_tool_use' ||
    block.type === 'web_search_tool_result' ||
    block.type === 'code_execution_tool_result' ||
    block.type === 'tool_use' ||
    block.type === 'tool_result'
  );
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('Claude did not return a JSON object.');
    }
    return JSON.parse(match[0]);
  }
}

function buildSystemPrompt() {
  return [
    'You are a bounded dynamic CSV execution agent.',
    'Your job is to inspect CSV text, create a plan, write transformation code, execute that code with the code execution tool, inspect output, and return structured JSON.',
    'You MUST use the code execution tool before returning your final answer.',
    'Do not fabricate successful execution. If execution fails, explain and retry with revised code.',
    'Preserve uncertain/invalid values and provide warnings instead of silently forcing a fix.',
    'Output format must be strict JSON with keys:',
    '{',
    '  "plan": "string",',
    '  "summary": "string",',
    '  "cleaned_csv": "string",',
    '  "generated_code_excerpt": "string",',
    '  "warnings": ["string"],',
    '  "validation_notes": ["string"]',
    '}'
  ].join('\n');
}

function buildUserPrompt({ task, csvText, iteration, maxIterations, priorFailures, priorOutput }) {
  const sections = [
    `Task: ${task || 'Clean and normalize this CSV.'}`,
    `Iteration: ${iteration} of ${maxIterations}`,
    'CSV input (raw text):',
    csvText
  ];

  if (priorOutput) {
    sections.push('', 'Previous candidate cleaned CSV:', priorOutput);
  }

  if (priorFailures?.length) {
    sections.push('', 'Validation failures from backend that must be fixed:', ...priorFailures.map((f) => `- ${f}`));
  }

  sections.push(
    '',
    'Requirements:',
    '- Analyze structure and provide a concise plan.',
    '- Write code and execute it with the code execution tool.',
    '- Return cleaned CSV with headers and data rows.',
    '- If task asks for deduplication/date normalization/missing value handling, satisfy that behavior.',
    '- Keep CSV valid and parseable.',
    '- Return strict JSON only.'
  );

  return sections.join('\n');
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

export async function executeDynamicCsvTask({ task, fileBuffer, apiKey, model }) {
  const taskText = (task || '').trim();
  if (!fileBuffer) {
    return buildAdvisoryResponse(taskText);
  }

  const csvText = fileBuffer.toString('utf-8');
  if (!csvText.trim()) {
    throw new Error('Uploaded CSV file is empty.');
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

  let finalPayload = null;
  let validation = null;
  let iterationsUsed = 0;
  let codeToolUsed = false;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    iterationsUsed = iteration;
    logs.push(`Generating transformation code (iteration ${iteration}/${MAX_ITERATIONS})...`);
    logs.push('Executing code in Anthropic sandbox...');

    let message;
    try {
      message = await anthropic.messages.create({
        model: model || DEFAULT_MODEL,
        max_tokens: 1800,
        temperature: 0,
        system: buildSystemPrompt(),
        tools: [
          {
            type: 'code_execution_20250522',
            name: 'code_execution'
          }
        ],
        messages: [
          {
            role: 'user',
            content: buildUserPrompt({
              task: taskText,
              csvText,
              iteration,
              maxIterations: MAX_ITERATIONS,
              priorFailures: validation?.failures,
              priorOutput: finalPayload?.cleaned_csv
            })
          }
        ]
      });
    } catch (error) {
      const details = error?.message || 'Unknown Anthropic error';
      throw new Error(`Dynamic Claude execution failed: ${details}`);
    }

    const content = Array.isArray(message.content) ? message.content : [];
    if (hasCodeToolSignals(content)) {
      codeToolUsed = true;
    }

    const responseText = extractTextBlocks(content);
    if (!responseText) {
      logs.push('Claude returned no text payload; retrying...');
      continue;
    }

    let candidate;
    try {
      candidate = parseJsonObject(responseText);
    } catch (error) {
      logs.push(`Claude returned non-JSON response on iteration ${iteration}; retrying...`);
      allWarnings.push(error.message);
      continue;
    }

    if (!candidate.cleaned_csv || typeof candidate.cleaned_csv !== 'string') {
      logs.push(`Candidate output missing cleaned_csv on iteration ${iteration}; retrying...`);
      allWarnings.push('Claude response missing cleaned_csv field.');
      finalPayload = candidate;
      continue;
    }

    logs.push('Inspecting generated output...');
    validation = validateDynamicCsvResult({
      task: taskText,
      inputCsv: csvText,
      outputCsv: candidate.cleaned_csv
    });

    finalPayload = candidate;
    allWarnings.push(...(candidate.warnings || []));
    allWarnings.push(...validation.warnings);

    if (validation.passed) {
      logs.push('Validation passed. Preparing final response...');
      break;
    }

    logs.push(`Validation failed: ${validation.failures.join(' ')} Retrying...`);
  }

  if (!finalPayload) {
    throw new Error('Claude failed to produce a usable dynamic execution payload.');
  }

  if (!validation) {
    validation = validateDynamicCsvResult({
      task: taskText,
      inputCsv: csvText,
      outputCsv: finalPayload.cleaned_csv || ''
    });
  }

  const summary = finalPayload.summary ? `Summary:\n${finalPayload.summary}` : 'Summary:\nNo summary returned.';
  const result = `${(finalPayload.cleaned_csv || '').trim()}\n\n${summary}`.trim();

  if (!codeToolUsed) {
    allWarnings.push('No explicit code-execution tool output detected; verify Anthropic tool availability.');
  }

  const inputRows = validation.rows_input ?? getInputRowCount(csvText);

  return {
    result,
    logs,
    metadata: {
      execution_mode: 'dynamic_agent_execution',
      rows_input: inputRows,
      rows_output: validation.rows_output ?? 0,
      duplicates_removed: validation.duplicates_removed,
      dates_normalized: validation.dates_normalized,
      validation_passed: validation.passed,
      iterations_used: iterationsUsed,
      warnings: Array.from(new Set(allWarnings.filter(Boolean))),
      dynamic_code_used: codeToolUsed
    },
    artifacts: {
      generated_code: finalPayload.generated_code_excerpt
        ? String(finalPayload.generated_code_excerpt).slice(0, 1200)
        : undefined,
      plan: finalPayload.plan
    }
  };
}
