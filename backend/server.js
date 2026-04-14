import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const STEP_LOGS = [
  'Analyzing input...',
  'Planning transformation...',
  'Executing cleaning...',
  'Validating output...',
  'Finalizing result...'
];

function parseClaudeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude response did not include JSON');
    return JSON.parse(match[0]);
  }
}

function getCSVStats(csvText) {
  if (!csvText.trim()) {
    return {
      rowsProcessed: 0,
      duplicatesRemoved: 0,
      uniqueRowsCount: 0,
      hasData: false
    };
  }

  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      rowsProcessed: 0,
      duplicatesRemoved: 0,
      uniqueRowsCount: 0,
      hasData: false
    };
  }

  const dataRows = lines.slice(1);
  const uniqueRows = new Set(dataRows);

  return {
    rowsProcessed: dataRows.length,
    duplicatesRemoved: Math.max(0, dataRows.length - uniqueRows.size),
    uniqueRowsCount: uniqueRows.size,
    hasData: true
  };
}

async function callClaudeStep(task, csvText, stepName, instruction, context) {
  const message = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
    max_tokens: 1200,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          'You are running one step in a multi-step data execution loop.',
          `Current step: ${stepName}`,
          '',
          `Task: ${task || '(no task provided)'}`,
          '',
          'CSV input:',
          csvText ? csvText : '(no CSV uploaded)',
          '',
          'Context from previous steps:',
          context ? JSON.stringify(context, null, 2) : '{}',
          '',
          instruction,
          '',
          'Return strictly valid JSON only.'
        ].join('\n')
      }
    ]
  });

  const textBlock = message.content.find((part) => part.type === 'text');
  if (!textBlock) {
    throw new Error(`No text response from Claude in step: ${stepName}`);
  }

  return parseClaudeJSON(textBlock.text);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/execute', upload.single('file'), async (req, res) => {
  try {
    const task = req.body.task || '';
    const csvText = req.file ? req.file.buffer.toString('utf-8') : '';

    if (!task.trim() && !csvText.trim()) {
      return res.status(400).json({
        error: 'Provide a task and/or CSV file.'
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: 'Missing ANTHROPIC_API_KEY in backend environment.'
      });
    }

    const logs = [];
    const csvStats = getCSVStats(csvText);

    logs.push(STEP_LOGS[0]);
    const analysis = await callClaudeStep(
      task,
      csvText,
      'Analyze task and input data',
      'Analyze the request. Return JSON with: {"input_summary":"...","detected_issues":["..."],"estimated_transformations":["..."]}.',
      { csv_stats: csvStats }
    );

    logs.push(STEP_LOGS[1]);
    const plan = await callClaudeStep(
      task,
      csvText,
      'Plan actions',
      'Create an execution plan. Return JSON with: {"plan":["step..."],"transformations_applied":["..."]}.',
      { analysis, csv_stats: csvStats }
    );

    logs.push(STEP_LOGS[2]);
    const execution = await callClaudeStep(
      task,
      csvText,
      'Execute transformation',
      'Simulate or perform transformation and return JSON with: {"cleaned_output":"...","execution_notes":["..."]}.',
      { analysis, plan, csv_stats: csvStats }
    );

    logs.push(STEP_LOGS[3]);
    const validation = await callClaudeStep(
      task,
      csvText,
      'Validate result',
      'Validate the transformed output. Return JSON with: {"validation_summary":"...","is_valid":true,"quality_checks":["..."]}.',
      { analysis, plan, execution, csv_stats: csvStats }
    );

    logs.push(STEP_LOGS[4]);
    const finalization = await callClaudeStep(
      task,
      csvText,
      'Produce final output',
      'Produce final concise output. Return JSON with: {"result":"...","summary":"..."}.',
      { analysis, plan, execution, validation, csv_stats: csvStats }
    );

    const transformationsApplied = Array.isArray(plan.transformations_applied)
      ? plan.transformations_applied
      : Array.isArray(analysis.estimated_transformations)
        ? analysis.estimated_transformations
        : [];

    const resultBody =
      typeof finalization.result === 'string' && finalization.result.trim()
        ? finalization.result
        : typeof execution.cleaned_output === 'string'
          ? execution.cleaned_output
          : '';

    const summary = typeof finalization.summary === 'string' ? finalization.summary : '';

    return res.json({
      result: summary ? `${resultBody}\n\nSummary:\n${summary}` : resultBody,
      logs,
      metadata: {
        rows_processed: csvStats.rowsProcessed,
        duplicates_removed: csvStats.duplicatesRemoved,
        transformations_applied: transformationsApplied,
        validation_passed: validation.is_valid !== false
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: 'Execution failed.',
      details: error?.message || 'Unknown error'
    });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
