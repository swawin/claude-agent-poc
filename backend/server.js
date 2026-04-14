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

function buildPrompt(task, csvText) {
  return [
    'You are a data operations assistant.',
    'Given a user task and optional CSV data, do the following:',
    '1) Analyze the CSV content (if provided).',
    '2) Describe clear cleaning/transformation steps.',
    '3) Produce a cleaned version of the data in plain text (CSV text is preferred).',
    '4) Provide a short summary of what was done.',
    '',
    'Return strictly valid JSON with this shape:',
    '{"logs": ["..."], "result": "...", "summary": "..."}',
    '',
    `Task: ${task || '(no task provided)'}`,
    '',
    'CSV input:',
    csvText ? csvText : '(no CSV uploaded)'
  ].join('\n');
}

function parseClaudeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude response did not include JSON');
    return JSON.parse(match[0]);
  }
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

    const message = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
      max_tokens: 2000,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: buildPrompt(task, csvText)
        }
      ]
    });

    const textBlock = message.content.find((part) => part.type === 'text');
    if (!textBlock) {
      return res.status(500).json({ error: 'No text response from Claude.' });
    }

    const parsed = parseClaudeJSON(textBlock.text);

    const logs = Array.isArray(parsed.logs) ? parsed.logs : [];
    const result = typeof parsed.result === 'string' ? parsed.result : '';
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';

    return res.json({
      result: summary ? `${result}\n\nSummary:\n${summary}` : result,
      logs
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
