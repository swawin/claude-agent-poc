import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { processCsv } from './lib/csvProcessor.js';
import {
  advisoryResponse,
  generateSummaryWithClaude,
  interpretTaskIntent
} from './lib/taskPlanner.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/execute', upload.single('file'), async (req, res) => {
  try {
    const task = (req.body.task || '').trim();
    const csvText = req.file ? req.file.buffer.toString('utf-8') : '';

    if (!task && !csvText.trim()) {
      return res.status(400).json({
        error: 'Provide a task and/or CSV file.'
      });
    }

    const logs = [];
    const warnings = [];

    if (!csvText.trim()) {
      logs.push('Analyzing request without uploaded CSV...');
      logs.push('Generating advisory strategy...');

      const advisory = await advisoryResponse(
        task,
        process.env.ANTHROPIC_API_KEY,
        process.env.CLAUDE_MODEL
      );

      if (advisory.note) warnings.push(advisory.note);

      logs.push('Finalizing advisory response...');

      return res.json({
        result: advisory.result,
        logs,
        metadata: {
          execution_mode: 'advisory',
          rows_input: 0,
          rows_output: 0,
          columns_detected: [],
          duplicates_removed: 0,
          date_columns_detected: [],
          dates_normalized: 0,
          missing_values_detected: 0,
          warnings,
          transformations_applied: ['No CSV execution; advisory-only strategy returned'],
          validation_passed: true,
          fallback_plan_used: advisory.fallback_used
        }
      });
    }

    logs.push('Analyzing uploaded CSV structure...');
    logs.push('Interpreting task intent...');

    const planner = await interpretTaskIntent(
      task,
      csvText.split(/\r?\n/).slice(0, 6).join('\n'),
      process.env.ANTHROPIC_API_KEY,
      process.env.CLAUDE_MODEL
    );

    if (planner.note) warnings.push(planner.note);

    logs.push('Normalizing headers and values...');
    logs.push('Scanning rows for duplicates and date values...');

    const execution = processCsv(csvText, planner.plan);
    const metadata = execution.metadata;

    logs.push('Validating cleaned output...');

    const summaryContext = {
      rows_input: metadata.rows_input,
      rows_output: metadata.rows_output,
      duplicates_removed: metadata.duplicates_removed,
      dates_normalized: metadata.dates_normalized,
      missing_values_detected: metadata.missing_values_detected,
      date_columns_detected: metadata.date_columns_detected
    };

    logs.push('Generating summary...');
    const summaryResponse = await generateSummaryWithClaude(
      summaryContext,
      process.env.ANTHROPIC_API_KEY,
      process.env.CLAUDE_MODEL
    );

    logs.push('Finalizing result...');

    return res.json({
      result: `${execution.csvOutput.trim()}\n\nSummary:\n${summaryResponse.summary}`,
      logs,
      metadata: {
        ...metadata,
        warnings: [...metadata.warnings, ...warnings],
        fallback_plan_used: planner.fallback_used,
        summary_generated_by: summaryResponse.used_claude ? 'claude' : 'backend_default'
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
